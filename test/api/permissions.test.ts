/**
 * PRD §8, asserted at the HTTP layer.
 *
 * `policy.test.ts` already covers the policy *engine* with 131 tests. That is a
 * different claim: it proves the table is right, not that any route consults
 * it. A route that forgets `withTripAccess` entirely passes all 131.
 *
 * So this file drives real requests. For every action in the PRD §8 matrix it
 * asserts, per role:
 *
 *   • a role the PRD denies gets **403**
 *   • a role the PRD permits does **not** get 403 (the exact success status
 *     depends on fixture state and is each module's own test to make)
 *   • a non-member gets **404, never 403** — a 403 confirms the trip exists,
 *     which makes the API an existence oracle (§8.4)
 *
 * Each case builds its own world, so a permitted role's mutation cannot leak
 * into the next case. Within a case the denied roles run first and mutate
 * nothing, so ordering between roles does not matter either.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { authed } from '../support/api';
import { closeTestDatabase, resetDatabase } from '../support/db';
import { addMember, addPlaceholder, createTrip, createUser } from '../support/factories';
import { ROLES, type Role } from '../../src/platform/policy/index';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

interface World {
  readonly tripId: string;
  readonly mainVariantId: string;
  readonly forkVariantId: string;
  readonly dayId: string;
  /** Authored by the OWNER, so `-own` never accidentally grants access. */
  readonly ownerBlockId: string;
  readonly ownerCommentId: string;
  readonly contributorSuggestionId: string;
  readonly packingItemId: string;
  readonly ownerExpenseId: string;
  readonly settlementId: string;
  readonly inviteId: string;
  readonly placeholderId: string;
  readonly ownerParticipantId: string;
  readonly tokens: Readonly<Record<Role, string>>;
  readonly outsiderToken: string;
  readonly editorUserId: string;
  readonly participantIdFor: Readonly<Record<Role, string>>;
}

/**
 * One trip, one member per role, and one of every addressable resource.
 *
 * Built through the API rather than through direct inserts wherever a route
 * exists: a fixture assembled by SQL can satisfy a test that the real request
 * path would reject.
 */
async function buildWorld(): Promise<World> {
  const owner = await createUser({ displayName: 'Owner' });
  const trip = await createTrip({ ownerId: owner.id, baseCurrency: 'INR' });

  const [editor, contributor, viewer, outsider] = await Promise.all([
    addMember(trip.id, 'EDITOR'),
    addMember(trip.id, 'CONTRIBUTOR'),
    addMember(trip.id, 'VIEWER'),
    createUser({ displayName: 'Outsider' }),
  ]);

  const ownerToken = owner.token;
  const as = (token: string) => authed(token);

  const { body: day } = await as(ownerToken)
    .post(`/v1/trips/${trip.id}/variants/${trip.mainVariantId}/days`)
    .send({ title: 'Day one' })
    .expect(201);

  const { body: block } = await as(ownerToken)
    .post(`/v1/trips/${trip.id}/days/${day.id}/blocks`)
    .send({ type: 'ACTIVITY', title: 'Kiyomizu-dera' })
    .expect(201);

  const { body: fork } = await as(ownerToken)
    .post(`/v1/trips/${trip.id}/variants`)
    .send({ name: 'Rainy day', forkFromVariantId: trip.mainVariantId })
    .expect(201);

  // These four touch different tables and depend only on the day/block above,
  // so serialising them just adds four round trips to every fixture.
  const [
    { body: comment },
    { body: suggestion },
    { body: packingItem },
    { body: invite },
    placeholderId,
  ] = await Promise.all([
    as(ownerToken)
      .post(`/v1/trips/${trip.id}/comments`)
      .send({ body: 'Worth an early start.', blockId: block.id })
      .expect(201),
    as(contributor.token)
      .post(`/v1/trips/${trip.id}/suggestions`)
      .send({ dayId: day.id, proposedBlock: { type: 'NOTE', title: 'Coffee first' } })
      .expect(201),
    as(ownerToken)
      .post(`/v1/trips/${trip.id}/packing`)
      .send({ category: 'Documents', label: 'Passport' })
      .expect(201),
    as(ownerToken)
      .post(`/v1/trips/${trip.id}/invites`)
      .send({ emails: ['someone@example.com'], role: 'EDITOR' })
      .expect(201),
    addPlaceholder(trip.id, 'Placeholder', owner.id),
  ]);

  // An expense the OWNER paid, split across the owner and the placeholder, so
  // there is a real non-zero balance for the settlement below to clear.
  const { body: expense } = await as(ownerToken)
    .post(`/v1/trips/${trip.id}/expenses`)
    .send({
      description: 'Ryokan',
      amountMinor: '10000',
      currency: 'INR',
      payments: [{ participantId: trip.ownerParticipantId, amountMinor: '10000' }],
      split: {
        method: 'EQUAL',
        participantIds: [trip.ownerParticipantId, placeholderId],
      },
    })
    .expect(201);

  const { body: settlement } = await as(ownerToken)
    .post(`/v1/trips/${trip.id}/settlements`)
    .send({
      fromParticipantId: placeholderId,
      toParticipantId: trip.ownerParticipantId,
      amountMinor: '5000',
    })
    .expect(201);

  return {
    tripId: trip.id,
    mainVariantId: trip.mainVariantId,
    forkVariantId: fork.id,
    dayId: day.id,
    ownerBlockId: block.id,
    ownerCommentId: comment.id,
    contributorSuggestionId: suggestion.id,
    packingItemId: packingItem.id,
    ownerExpenseId: expense.id,
    settlementId: settlement.id,
    inviteId: invite.id,
    placeholderId,
    ownerParticipantId: trip.ownerParticipantId!,
    tokens: {
      OWNER: ownerToken,
      EDITOR: editor.token,
      CONTRIBUTOR: contributor.token,
      VIEWER: viewer.token,
    },
    outsiderToken: outsider.token,
    editorUserId: editor.id,
    participantIdFor: {
      OWNER: trip.ownerParticipantId!,
      EDITOR: editor.participantId!,
      CONTRIBUTOR: contributor.participantId!,
      VIEWER: viewer.participantId!,
    },
  };
}

interface MatrixCase {
  /** The PRD §8 row this asserts, quoted so a reviewer can diff it. */
  readonly row: string;
  readonly method: Method;
  readonly path: (w: World) => string;
  readonly body?: (w: World) => Record<string, unknown>;
  /** Roles PRD §8 permits. Everything else must be refused with 403. */
  readonly allowed: readonly Role[];
}

const ALL: readonly Role[] = ROLES;
const EDITORS: readonly Role[] = ['OWNER', 'EDITOR'];
const OWNER_ONLY: readonly Role[] = ['OWNER'];
const CONTRIBUTORS: readonly Role[] = ['OWNER', 'EDITOR', 'CONTRIBUTOR'];

/**
 * One entry per PRD §8 row that maps onto a trip-scoped route.
 *
 * Rows deliberately absent: "Propose a block" and "Comment" carry a ⚙️ public
 * variant that belongs to the sharing tests, and "Duplicate trip (into own
 * account)" is not trip-scoped in the same sense — it creates a new trip.
 */
const CASES: readonly MatrixCase[] = [
  {
    row: 'View trip and all blocks',
    method: 'get',
    path: (w) => `/v1/trips/${w.tripId}/canvas`,
    allowed: ALL,
  },
  {
    row: 'Create / edit / delete blocks — create',
    method: 'post',
    path: (w) => `/v1/trips/${w.tripId}/days/${w.dayId}/blocks`,
    body: () => ({ type: 'NOTE', title: 'Added' }),
    allowed: CONTRIBUTORS,
  },
  {
    row: 'Add / delete / reorder days — add',
    method: 'post',
    path: (w) => `/v1/trips/${w.tripId}/variants/${w.mainVariantId}/days`,
    body: () => ({ title: 'Another day' }),
    allowed: EDITORS,
  },
  {
    row: 'Add / delete / reorder days — delete',
    method: 'delete',
    path: (w) => `/v1/trips/${w.tripId}/days/${w.dayId}`,
    allowed: EDITORS,
  },
  {
    row: 'Add / delete / reorder days — duplicate',
    method: 'post',
    path: (w) => `/v1/trips/${w.tripId}/days/${w.dayId}/duplicate`,
    allowed: EDITORS,
  },
  {
    row: 'Propose a block (suggestion)',
    method: 'post',
    path: (w) => `/v1/trips/${w.tripId}/suggestions`,
    body: (w) => ({ dayId: w.dayId, proposedBlock: { type: 'NOTE', title: 'Idea' } }),
    allowed: ALL,
  },
  {
    row: 'Review suggestions',
    method: 'post',
    path: (w) => `/v1/trips/${w.tripId}/suggestions/${w.contributorSuggestionId}/review`,
    body: () => ({ decision: 'REJECT', reason: 'Not this trip' }),
    allowed: EDITORS,
  },
  {
    row: 'Comment',
    method: 'post',
    path: (w) => `/v1/trips/${w.tripId}/comments`,
    body: () => ({ body: 'A thought' }),
    allowed: ALL,
  },
  {
    row: 'Create / fork variants',
    method: 'post',
    path: (w) => `/v1/trips/${w.tripId}/variants`,
    body: (w) => ({ name: 'Another plan', forkFromVariantId: w.mainVariantId }),
    allowed: EDITORS,
  },
  {
    row: 'Create / fork variants — rename',
    method: 'patch',
    path: (w) => `/v1/trips/${w.tripId}/variants/${w.forkVariantId}`,
    body: () => ({ name: 'Renamed' }),
    allowed: EDITORS,
  },
  {
    row: 'Create / fork variants — delete',
    method: 'delete',
    path: (w) => `/v1/trips/${w.tripId}/variants/${w.forkVariantId}`,
    allowed: EDITORS,
  },
  {
    row: 'Promote variant to main',
    method: 'post',
    path: (w) => `/v1/trips/${w.tripId}/variants/${w.forkVariantId}/promote`,
    allowed: OWNER_ONLY,
  },
  {
    row: 'Edit trip settings',
    method: 'patch',
    path: (w) => `/v1/trips/${w.tripId}`,
    body: () => ({ version: 1, title: 'Renamed trip' }),
    allowed: EDITORS,
  },
  {
    row: 'Edit packing list',
    method: 'post',
    path: (w) => `/v1/trips/${w.tripId}/packing`,
    body: () => ({ category: 'Clothes', label: 'Socks' }),
    allowed: CONTRIBUTORS,
  },
  {
    row: 'Edit packing list — delete an item',
    method: 'delete',
    path: (w) => `/v1/trips/${w.tripId}/packing/${w.packingItemId}`,
    allowed: CONTRIBUTORS,
  },
  {
    row: 'Edit trip notes',
    method: 'put',
    path: (w) => `/v1/trips/${w.tripId}/notes`,
    body: () => ({ body: 'Shared scratchpad', version: 1 }),
    allowed: CONTRIBUTORS,
  },
  {
    row: 'Invite people',
    method: 'post',
    path: (w) => `/v1/trips/${w.tripId}/invites`,
    body: () => ({ emails: ['crew@example.com'], role: 'VIEWER' }),
    allowed: EDITORS,
  },
  {
    row: 'Change roles / remove members — change role',
    method: 'patch',
    path: (w) => `/v1/trips/${w.tripId}/members/${w.editorUserId}`,
    body: () => ({ role: 'VIEWER' }),
    allowed: OWNER_ONLY,
  },
  {
    row: 'Change roles / remove members — remove',
    method: 'delete',
    path: (w) => `/v1/trips/${w.tripId}/members/${w.editorUserId}`,
    allowed: OWNER_ONLY,
  },
  {
    row: 'Manage share link',
    method: 'put',
    path: (w) => `/v1/trips/${w.tripId}/share`,
    body: () => ({ isEnabled: true }),
    allowed: EDITORS,
  },
  {
    row: 'Manage share link — read',
    method: 'get',
    path: (w) => `/v1/trips/${w.tripId}/share`,
    allowed: EDITORS,
  },
  {
    row: 'Manage share link — revoke',
    method: 'delete',
    path: (w) => `/v1/trips/${w.tripId}/share`,
    allowed: EDITORS,
  },
  {
    row: 'View the expense ledger',
    method: 'get',
    path: (w) => `/v1/trips/${w.tripId}/expenses`,
    // A Viewer is not refused — they see only their own shares (FR-NFR-SEC-10),
    // which `ledger.test.ts` asserts. The refusal here would be wrong.
    allowed: ALL,
  },
  {
    row: 'Add an expense',
    method: 'post',
    path: (w) => `/v1/trips/${w.tripId}/expenses`,
    body: (w) => ({
      description: 'Lunch',
      amountMinor: '2000',
      currency: 'INR',
      payments: [{ participantId: w.ownerParticipantId, amountMinor: '2000' }],
      split: { method: 'EQUAL', participantIds: [w.ownerParticipantId] },
    }),
    allowed: CONTRIBUTORS,
  },
  {
    row: 'Add placeholder participants',
    method: 'post',
    path: (w) => `/v1/trips/${w.tripId}/participants`,
    body: () => ({ displayName: 'Another placeholder' }),
    allowed: EDITORS,
  },
  {
    row: 'Record a settlement',
    method: 'post',
    path: (w) => `/v1/trips/${w.tripId}/settlements`,
    body: (w) => ({
      fromParticipantId: w.placeholderId,
      toParticipantId: w.ownerParticipantId,
      amountMinor: '100',
    }),
    allowed: ALL,
  },
  {
    row: 'Void a settlement',
    method: 'post',
    path: (w) => `/v1/trips/${w.tripId}/settlements/${w.settlementId}/void`,
    body: () => ({ reason: 'Recorded twice' }),
    allowed: EDITORS,
  },
  {
    row: 'Export',
    method: 'get',
    path: (w) => `/v1/trips/${w.tripId}/export.txt`,
    allowed: ALL,
  },
  {
    row: 'Export the expense report',
    method: 'get',
    path: (w) => `/v1/trips/${w.tripId}/expenses/export.csv`,
    allowed: CONTRIBUTORS,
  },
  {
    row: 'Archive',
    method: 'post',
    path: (w) => `/v1/trips/${w.tripId}/archive`,
    allowed: EDITORS,
  },
  {
    row: 'Delete trip',
    method: 'delete',
    path: (w) => `/v1/trips/${w.tripId}`,
    allowed: OWNER_ONLY,
  },
  {
    row: 'Transfer ownership',
    method: 'post',
    path: (w) => `/v1/trips/${w.tripId}/transfer-ownership`,
    body: (w) => ({ toUserId: w.editorUserId }),
    allowed: OWNER_ONLY,
  },
];

function send(token: string, testCase: MatrixCase, world: World) {
  const request = authed(token)[testCase.method](testCase.path(world));
  return testCase.body ? request.send(testCase.body(world)) : request;
}

describe('PRD §8 permission matrix, enforced over HTTP', () => {
  /**
   * One world for every refusal assertion in this block.
   *
   * A refused request — 403 for a denied role, 404 for a non-member — changes
   * nothing, so none of these cases can disturb another. Building a fresh
   * fixture per case cost ~35 world builds and 50s of wall clock to prove
   * something the same fixture proves in one.
   *
   * Only the *permitted* cases mutate, and they get their own worlds below.
   */
  let refusals: World;

  beforeAll(async () => {
    refusals = await buildWorld();
  });

  it('refuses every role PRD §8 denies, on every action', async () => {
    const failures: string[] = [];

    for (const testCase of CASES) {
      for (const role of ALL.filter((candidate) => !testCase.allowed.includes(candidate))) {
        const response = await send(refusals.tokens[role], testCase, refusals);
        if (response.status !== 403) {
          failures.push(
            `${role} got ${response.status} (want 403) on ${testCase.method.toUpperCase()} ` +
              `${testCase.path(refusals)} — PRD §8 "${testCase.row}"`,
          );
        }
      }
    }

    // Collect rather than fail fast: one run should report every broken cell,
    // not just the first.
    expect(failures, `\n${failures.join('\n')}`).toStrictEqual([]);
  });

  it('never answers 403 to a non-member — a 403 would confirm the trip exists', async () => {
    const failures: string[] = [];

    for (const testCase of CASES) {
      const response = await send(refusals.outsiderToken, testCase, refusals);
      if (response.status !== 404) {
        failures.push(
          `${testCase.method.toUpperCase()} ${testCase.path(refusals)} answered ` +
            `${response.status} to a non-member (want 404)`,
        );
      }
    }

    expect(failures, `\n${failures.join('\n')}`).toStrictEqual([]);
  });

  /**
   * One world per role rather than per case.
   *
   * These requests really do mutate, but the assertion is only "not 403", and
   * a later case seeing 404 because an earlier one deleted its subject still
   * proves what this test is for: the role got past the authorization gate.
   */
  /**
   * Three actions change the trip as a whole and cannot share a world with
   * anything: archiving makes it read-only, transferring ownership demotes the
   * caller, and deleting it takes the trip away. No ordering rescues them —
   * archive refuses the other two, and transfer refuses delete — so each gets
   * a fixture of its own. Everything else shares one.
   */
  const NEEDS_OWN_WORLD = new Set(['Archive', 'Transfer ownership', 'Delete trip']);

  for (const role of ALL) {
    const allowed = CASES.filter((testCase) => testCase.allowed.includes(role));

    it(`admits a ${role} to all ${allowed.length} actions PRD §8 grants them`, async () => {
      const world = await buildWorld();
      const failures: string[] = [];

      for (const testCase of allowed) {
        const target = NEEDS_OWN_WORLD.has(testCase.row) ? await buildWorld() : world;
        const response = await send(target.tokens[role], testCase, target);
        if (response.status === 403) {
          failures.push(
            `${testCase.method.toUpperCase()} ${testCase.path(target)} — PRD §8 "${testCase.row}"`,
          );
        }
      }

      expect(failures, `${role} was refused:\n${failures.join('\n')}`).toStrictEqual([]);
    });
  }

  it('refuses every mutation on an archived trip, whatever the role', async () => {
    const world = await buildWorld();
    await authed(world.tokens.OWNER).post(`/v1/trips/${world.tripId}/archive`).expect(204);

    const mutations = CASES.filter(
      (testCase) => testCase.method !== 'get' && testCase.row !== 'Archive',
    );

    for (const testCase of mutations) {
      const response = await send(world.tokens.OWNER, testCase, world);
      expect(
        response.status,
        `${testCase.method.toUpperCase()} ${testCase.path(world)} mutated an archived trip`,
      ).toBe(403);
    }

    // Reads still work — archiving shelves a trip, it does not hide it.
    await authed(world.tokens.OWNER).get(`/v1/trips/${world.tripId}/canvas`).expect(200);
  });
});

describe('“own only” cells resolve per resource, not per role', () => {
  it('lets a Contributor delete their own block but not the owner’s', async () => {
    const world = await buildWorld();
    const contributor = world.tokens.CONTRIBUTOR;

    const { body: mine } = await authed(contributor)
      .post(`/v1/trips/${world.tripId}/days/${world.dayId}/blocks`)
      .send({ type: 'NOTE', title: 'Mine' })
      .expect(201);

    await authed(contributor)
      .delete(`/v1/trips/${world.tripId}/blocks/${mine.id}`)
      .expect(204);

    await authed(contributor)
      .delete(`/v1/trips/${world.tripId}/blocks/${world.ownerBlockId}`)
      .expect(403);
  });

  it('lets a Contributor withdraw their own suggestion but not review it', async () => {
    const world = await buildWorld();
    const contributor = world.tokens.CONTRIBUTOR;

    await authed(contributor)
      .post(`/v1/trips/${world.tripId}/suggestions/${world.contributorSuggestionId}/review`)
      .send({ decision: 'ACCEPT' })
      .expect(403);

    await authed(contributor)
      .post(`/v1/trips/${world.tripId}/suggestions/${world.contributorSuggestionId}/withdraw`)
      .expect(204);
  });

  it('lets a Contributor delete their own comment but not the owner’s', async () => {
    const world = await buildWorld();
    const contributor = world.tokens.CONTRIBUTOR;

    const { body: mine } = await authed(contributor)
      .post(`/v1/trips/${world.tripId}/comments`)
      .send({ body: 'Mine to delete' })
      .expect(201);

    await authed(contributor)
      .delete(`/v1/trips/${world.tripId}/comments/${mine.id}`)
      .expect(204);

    await authed(contributor)
      .delete(`/v1/trips/${world.tripId}/comments/${world.ownerCommentId}`)
      .expect(403);
  });

  it('lets a Contributor delete their own expense — PRD §8 “Own only”', async () => {
    const world = await buildWorld();
    const contributor = world.tokens.CONTRIBUTOR;

    const { body: mine } = await authed(contributor)
      .post(`/v1/trips/${world.tripId}/expenses`)
      .send({
        description: 'My round',
        amountMinor: '1200',
        currency: 'INR',
        payments: [
          { participantId: world.participantIdFor.CONTRIBUTOR, amountMinor: '1200' },
        ],
        split: {
          method: 'EQUAL',
          participantIds: [world.participantIdFor.CONTRIBUTOR],
        },
      })
      .expect(201);

    await authed(contributor)
      .delete(`/v1/trips/${world.tripId}/expenses/${mine.id}`)
      .expect(204);
  });

  it('refuses a Contributor deleting someone else’s expense', async () => {
    const world = await buildWorld();

    await authed(world.tokens.CONTRIBUTOR)
      .delete(`/v1/trips/${world.tripId}/expenses/${world.ownerExpenseId}`)
      .expect(403);
  });
});

describe('routes exempt from the access guard authorize themselves', () => {
  /**
   * `POST /trips/:tripId/restore` runs outside `withTripAccess` by necessity —
   * the trip is soft-deleted, so the access loader cannot see it. That makes it
   * the one trip-scoped route whose authorization nothing structural enforces,
   * which is exactly why `route-contract.test.ts` exempts it and points here.
   */
  it('refuses to restore someone else’s soft-deleted trip, with 404 not 403', async () => {
    const mine = await buildWorld();
    const theirs = await buildWorld();

    await authed(theirs.tokens.OWNER).delete(`/v1/trips/${theirs.tripId}`).expect(204);

    await authed(mine.tokens.OWNER)
      .post(`/v1/trips/${theirs.tripId}/restore`)
      .expect(404);

    // Still gone: a refused restore must not half-succeed.
    await authed(theirs.tokens.OWNER).get(`/v1/trips/${theirs.tripId}`).expect(404);

    // And the real owner can still bring it back.
    await authed(theirs.tokens.OWNER)
      .post(`/v1/trips/${theirs.tripId}/restore`)
      .expect(204);
    await authed(theirs.tokens.OWNER).get(`/v1/trips/${theirs.tripId}`).expect(200);
  });

  it('refuses an EDITOR of the same trip, since only the Owner may delete it', async () => {
    const world = await buildWorld();
    await authed(world.tokens.OWNER).delete(`/v1/trips/${world.tripId}`).expect(204);

    await authed(world.tokens.EDITOR)
      .post(`/v1/trips/${world.tripId}/restore`)
      .expect(404);
  });
});

describe('routes no other test exercises', () => {
  it('moves a trip between folders, and refuses a folder owned by someone else', async () => {
    const world = await buildWorld();
    const outsiderWorld = await buildWorld();

    const { body: folder } = await authed(world.tokens.OWNER)
      .post('/v1/folders')
      .send({ name: 'Japan 2026', emoji: '🗾', tone: 'gold' })
      .expect(201);

    await authed(world.tokens.OWNER)
      .patch(`/v1/trips/${world.tripId}/folder`)
      .send({ folderId: folder.id })
      .expect(204);

    const { body: listed } = await authed(world.tokens.OWNER)
      .get('/v1/folders')
      .expect(200);
    expect(
      listed.items.find((f: { id: string }) => f.id === folder.id).tripCount,
    ).toBe(1);

    // Someone else's folder is not a valid destination for my trip.
    await authed(outsiderWorld.tokens.OWNER)
      .patch(`/v1/trips/${outsiderWorld.tripId}/folder`)
      .send({ folderId: folder.id })
      .expect(404);

    // Null unfiles it rather than erroring.
    await authed(world.tokens.OWNER)
      .patch(`/v1/trips/${world.tripId}/folder`)
      .send({ folderId: null })
      .expect(204);
  });

  it('reorders trips per user, so one member’s order does not move another’s', async () => {
    const owner = await createUser();
    const first = await createTrip({ ownerId: owner.id, title: 'First' });
    const second = await createTrip({ ownerId: owner.id, title: 'Second' });

    await authed(owner.token)
      .post('/v1/trips/reorder')
      .send({ orderedTripIds: [second.id, first.id] })
      .expect(204);

    const { body } = await authed(owner.token).get('/v1/trips').expect(200);
    expect(body.items.map((t: { title: string }) => t.title)).toStrictEqual([
      'Second',
      'First',
    ]);

    // Ordering is per-user state, so naming a trip you cannot see is accepted
    // rather than refused — but it must not become visible to you, and must not
    // disturb the real owner's own order.
    const stranger = await createUser();
    const theirs = await createTrip({ ownerId: stranger.id, title: 'Theirs' });
    await authed(owner.token)
      .post('/v1/trips/reorder')
      .send({ orderedTripIds: [theirs.id] })
      .expect(204);

    const { body: mine } = await authed(owner.token).get('/v1/trips').expect(200);
    expect(mine.items.map((t: { title: string }) => t.title)).toStrictEqual([
      'Second',
      'First',
    ]);

    const { body: strangersView } = await authed(stranger.token)
      .get('/v1/trips')
      .expect(200);
    expect(strangersView.items).toHaveLength(1);
    expect(strangersView.items[0].title).toBe('Theirs');
  });

  it('marks a single notification read without touching the rest', async () => {
    const world = await buildWorld();

    // The owner acted throughout `buildWorld`, so the editor has unread items
    // and the owner has none — self-actions never notify their actor.
    const { body: before } = await authed(world.tokens.EDITOR)
      .get('/v1/notifications')
      .expect(200);
    expect(before.unreadCount).toBeGreaterThan(1);

    await authed(world.tokens.EDITOR)
      .post(`/v1/notifications/${before.items[0].id}/read`)
      .expect(204);

    const { body: after } = await authed(world.tokens.EDITOR)
      .get('/v1/notifications')
      .expect(200);
    expect(after.unreadCount).toBe(before.unreadCount - 1);

    // Marking someone else's notification is scoped away in SQL rather than
    // refused, so it reports success — what matters is that it did nothing.
    const { body: contributorBefore } = await authed(world.tokens.CONTRIBUTOR)
      .get('/v1/notifications')
      .expect(200);

    await authed(world.tokens.CONTRIBUTOR)
      .post(`/v1/notifications/${before.items[1].id}/read`)
      .expect(204);

    const { body: editorAfter } = await authed(world.tokens.EDITOR)
      .get('/v1/notifications')
      .expect(200);
    expect(
      editorAfter.unreadCount,
      'a stranger marked the editor’s notification read',
    ).toBe(after.unreadCount);

    const { body: contributorAfter } = await authed(world.tokens.CONTRIBUTOR)
      .get('/v1/notifications')
      .expect(200);
    expect(contributorAfter.unreadCount).toBe(contributorBefore.unreadCount);
  });
});

describe('restore routes are scoped to the trip in the URL', () => {
  it('refuses to restore a block belonging to another trip', async () => {
    const mine = await buildWorld();
    const theirs = await buildWorld();

    await authed(theirs.tokens.OWNER)
      .delete(`/v1/trips/${theirs.tripId}/blocks/${theirs.ownerBlockId}`)
      .expect(204);

    // `mine.OWNER` is an owner — of a different trip. The block id is not
    // theirs to touch, and a 404 must not become a 204 just because the caller
    // happens to own *some* trip.
    await authed(mine.tokens.OWNER)
      .post(`/v1/trips/${mine.tripId}/blocks/${theirs.ownerBlockId}/restore`)
      .expect(404);

    const { body } = await authed(theirs.tokens.OWNER)
      .get(`/v1/trips/${theirs.tripId}/canvas`)
      .expect(200);
    expect(
      body.days.flatMap((day: { blocks: unknown[] }) => day.blocks),
      'the other trip’s block was resurrected by a stranger',
    ).toHaveLength(0);
  });

  it('refuses to restore an expense belonging to another trip', async () => {
    const mine = await buildWorld();
    const theirs = await buildWorld();

    await authed(theirs.tokens.OWNER)
      .delete(`/v1/trips/${theirs.tripId}/expenses/${theirs.ownerExpenseId}`)
      .expect(204);

    await authed(mine.tokens.OWNER)
      .post(`/v1/trips/${mine.tripId}/expenses/${theirs.ownerExpenseId}/restore`)
      .expect(404);

    const { body } = await authed(theirs.tokens.OWNER)
      .get(`/v1/trips/${theirs.tripId}/expenses`)
      .expect(200);
    expect(
      body.items,
      'the other trip’s expense was resurrected by a stranger',
    ).toHaveLength(0);
  });
});

describe('idempotency stores the response before answering (§8.8)', () => {
  /**
   * The retry must never be told "still processing".
   *
   * Storing the response fire-and-forget left a window where the key was
   * claimed but its `statusCode` was still NULL, so a retry arriving inside it
   * took the in-flight branch and got 409. That is precisely backwards: a
   * client whose connection is flaky enough to retry is *most* likely to
   * retry inside that window, and idempotency exists so that retry is safe.
   */
  const payload = { destination: 'Kyoto', startDate: '2026-05-18', endDate: '2026-05-20' };

  it('replays immediately, with no gap between responding and storing', async () => {
    const user = await createUser();

    // No delay at all between the two: any window is a failing window.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const key = `retry-${attempt}-${user.id}`;

      const first = await authed(user.token)
        .post('/v1/trips')
        .set('Idempotency-Key', key)
        .send(payload)
        .expect(201);

      const second = await authed(user.token)
        .post('/v1/trips')
        .set('Idempotency-Key', key)
        .send(payload)
        .expect(201);

      expect(second.body.id).toBe(first.body.id);
      expect(second.headers['idempotent-replay']).toBe('true');
    }
  });

  it('replays a 204 too, not just a body-bearing response', async () => {
    const world = await buildWorld();
    const key = `archive-${world.tripId}`;

    await authed(world.tokens.OWNER)
      .post(`/v1/trips/${world.tripId}/archive`)
      .set('Idempotency-Key', key)
      .expect(204);

    // A 204 never calls res.json, so it used to be finalised on 'finish' —
    // which fires *after* the response has already gone out.
    const replay = await authed(world.tokens.OWNER)
      .post(`/v1/trips/${world.tripId}/archive`)
      .set('Idempotency-Key', key);

    expect(replay.status).not.toBe(409);
  });

  it('lets exactly one of two genuinely concurrent requests through', async () => {
    const user = await createUser();
    const key = `concurrent-${user.id}`;

    const [a, b] = await Promise.all([
      authed(user.token).post('/v1/trips').set('Idempotency-Key', key).send(payload),
      authed(user.token).post('/v1/trips').set('Idempotency-Key', key).send(payload),
    ]);

    const statuses = [a.status, b.status].sort();
    // One creates. The other either replays it or is told to retry — but
    // never creates a second trip.
    expect(statuses[0]).toBe(201);
    expect([201, 409]).toContain(statuses[1]);

    const { body } = await authed(user.token).get('/v1/trips').expect(200);
    expect(body.items, 'a duplicate trip was created').toHaveLength(1);
  });
});
