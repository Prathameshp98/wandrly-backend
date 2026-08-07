/**
 * Collaboration API tests — members, invites, comments, suggestions.
 *
 * The invite tests matter most: accepting one is the only route in the system
 * that runs OUTSIDE `withTripAccess`, because the caller is not a member yet.
 * The emailed token is the authorization, so it gets adversarial coverage.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { authed } from '../support/api';
import { closeTestDatabase, db, resetDatabase } from '../support/db';
import { addMember, createTrip, createUser } from '../support/factories';
import { invites } from '../../src/platform/db/schema/index';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  // Each file owns its pool under `isolate: true`, so each closes its own.
  await closeTestDatabase();
});

/**
 * The token only exists in the email, which the test harness does not receive.
 * Re-deriving it is impossible (it is stored hashed), so tests re-issue a known
 * token directly — mirroring what the emailed link would carry.
 */
async function issueToken(tripId: string, email: string): Promise<string> {
  const { sha256 } = await import('../../src/platform/crypto/index');
  const token = `test-token-${Math.abs(Date.now() % 1e9)}-${email}`;
  await db
    .update(invites)
    .set({ tokenHash: sha256(token) })
    .where(eq(invites.tripId, tripId));
  return token;
}

describe('members', () => {
  it('lists the crew with roles and presence', async () => {
    const owner = await createUser({ displayName: 'Arjun' });
    const trip = await createTrip({ ownerId: owner.id });
    await addMember(trip.id, 'EDITOR', { displayName: 'Priya' });

    const { body } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/members`)
      .expect(200);

    expect(body.items).toHaveLength(2);
    expect(body.items[0].role).toBe('OWNER');
    expect(body.items[0].displayName).toBe('Arjun');
    // Nobody has sent a heartbeat yet.
    expect(body.items[0].isLive).toBe(false);
  });

  it('marks a member live after a presence heartbeat', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });

    await authed(owner.token).post(`/v1/trips/${trip.id}/presence`).expect(204);

    const { body } = await authed(owner.token).get(`/v1/trips/${trip.id}/members`);
    expect(body.items[0].isLive).toBe(true);
  });

  it('lets the OWNER change another member’s role', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const member = await addMember(trip.id, 'CONTRIBUTOR');

    await authed(owner.token)
      .patch(`/v1/trips/${trip.id}/members/${member.id}`)
      .send({ role: 'EDITOR' })
      .expect(204);

    const { body } = await authed(owner.token).get(`/v1/trips/${trip.id}/members`);
    expect(body.items.find((m: { userId: string }) => m.userId === member.id).role).toBe('EDITOR');
  });

  it('forbids an EDITOR from changing roles (PRD §8)', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const editor = await addMember(trip.id, 'EDITOR');
    const other = await addMember(trip.id, 'CONTRIBUTOR');

    await authed(editor.token)
      .patch(`/v1/trips/${trip.id}/members/${other.id}`)
      .send({ role: 'EDITOR' })
      .expect(403);
  });

  it('refuses to make a second owner via role change', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const member = await addMember(trip.id, 'EDITOR');

    const { body } = await authed(owner.token)
      .patch(`/v1/trips/${trip.id}/members/${member.id}`)
      .send({ role: 'OWNER' })
      .expect(422);

    expect(body.error.message).toMatch(/ownership transfer/i);
  });

  it('refuses to change your own role', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });

    await authed(owner.token)
      .patch(`/v1/trips/${trip.id}/members/${owner.id}`)
      .send({ role: 'EDITOR' })
      .expect(422);
  });

  it('transfers ownership and leaves exactly one owner (FR-COLLAB-12)', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const heir = await addMember(trip.id, 'EDITOR');

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/transfer-ownership`)
      .send({ toUserId: heir.id })
      .expect(204);

    const { body } = await authed(heir.token).get(`/v1/trips/${trip.id}/members`);
    const owners = body.items.filter((m: { role: string }) => m.role === 'OWNER');

    expect(owners).toHaveLength(1);
    expect(owners[0].userId).toBe(heir.id);
    // The previous owner is demoted, not removed.
    expect(body.items).toHaveLength(2);

    // And the old owner has genuinely lost owner powers.
    await authed(owner.token).delete(`/v1/trips/${trip.id}`).expect(403);
  });

  it('refuses to transfer ownership to a non-member', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const stranger = await createUser();

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/transfer-ownership`)
      .send({ toUserId: stranger.id })
      .expect(422);
  });

  it('refuses to remove the owner', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const editor = await addMember(trip.id, 'EDITOR');
    void editor;

    // Even the owner cannot remove themselves this way.
    await authed(owner.token)
      .delete(`/v1/trips/${trip.id}/members/${owner.id}`)
      .expect(422);
  });

  it('removing a member keeps their ledger identity (FR-SPLIT-05)', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const member = await addMember(trip.id, 'EDITOR');

    await authed(owner.token)
      .delete(`/v1/trips/${trip.id}/members/${member.id}`)
      .expect(204);

    // Gone from the crew…
    const { body: members } = await authed(owner.token).get(`/v1/trips/${trip.id}/members`);
    expect(members.items).toHaveLength(1);

    // …but still in the ledger, because they may owe money.
    const { body: participants } = await authed(owner.token).get(
      `/v1/trips/${trip.id}/participants`,
    );
    expect(participants.items).toHaveLength(2);
  });
});

describe('invites', () => {
  it('sends an invite and lists it for the trip', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });

    const { body } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/invites`)
      .send({ emails: ['priya@test.dev'], role: 'EDITOR', personalNote: 'Come plan with us' })
      .expect(201);

    expect(body.sent).toHaveLength(1);

    const { body: listed } = await authed(owner.token).get(`/v1/trips/${trip.id}/invites`);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].email).toBe('priya@test.dev');
    // The token must never appear in a listing.
    expect(JSON.stringify(listed)).not.toMatch(/tokenHash|token/i);
  });

  it('accepts an invite, adding membership and a ledger identity', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const invitee = await createUser();

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/invites`)
      .send({ emails: [invitee.email], role: 'EDITOR' })
      .expect(201);

    const token = await issueToken(trip.id, invitee.email);

    const { body } = await authed(invitee.token)
      .post('/v1/invites/accept')
      .send({ token })
      .expect(200);

    expect(body.tripId).toBe(trip.id);
    expect(body.role).toBe('EDITOR');

    // They can now see the trip, and appear in the ledger.
    await authed(invitee.token).get(`/v1/trips/${trip.id}`).expect(200);
    const { body: participants } = await authed(invitee.token).get(
      `/v1/trips/${trip.id}/participants`,
    );
    expect(participants.items).toHaveLength(2);
  });

  it('refuses a token addressed to someone else', async () => {
    // The invite belongs to an email address, not to whoever holds the link.
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const invitee = await createUser();
    const interloper = await createUser();

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/invites`)
      .send({ emails: [invitee.email] })
      .expect(201);

    const token = await issueToken(trip.id, invitee.email);

    await authed(interloper.token).post('/v1/invites/accept').send({ token }).expect(403);
    await authed(interloper.token).get(`/v1/trips/${trip.id}`).expect(404);
  });

  it('rejects an unknown token', async () => {
    const user = await createUser();
    await authed(user.token)
      .post('/v1/invites/accept')
      .send({ token: 'totally-made-up-token' })
      .expect(404);
  });

  it('rejects an expired invite', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const invitee = await createUser();

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/invites`)
      .send({ emails: [invitee.email] })
      .expect(201);

    const token = await issueToken(trip.id, invitee.email);
    await db
      .update(invites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invites.tripId, trip.id));

    const { body } = await authed(invitee.token)
      .post('/v1/invites/accept')
      .send({ token })
      .expect(422);

    expect(body.error.message).toMatch(/expired/i);
  });

  it('cannot be accepted twice', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const invitee = await createUser();

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/invites`)
      .send({ emails: [invitee.email] })
      .expect(201);

    const token = await issueToken(trip.id, invitee.email);
    await authed(invitee.token).post('/v1/invites/accept').send({ token }).expect(200);
    await authed(invitee.token).post('/v1/invites/accept').send({ token }).expect(422);
  });

  it('lists the invitee’s own pending invites', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id, title: 'Kyoto in Spring' });
    const invitee = await createUser();

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/invites`)
      .send({ emails: [invitee.email] })
      .expect(201);

    const { body } = await authed(invitee.token).get('/v1/invites').expect(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].tripTitle).toBe('Kyoto in Spring');
    expect(body.items[0].inviterName).toBeTruthy();
  });

  it('declines an invite', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const invitee = await createUser();

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/invites`)
      .send({ emails: [invitee.email] })
      .expect(201);

    const token = await issueToken(trip.id, invitee.email);
    await authed(invitee.token).post('/v1/invites/decline').send({ token }).expect(204);

    const { body } = await authed(invitee.token).get('/v1/invites');
    expect(body.items).toHaveLength(0);
    await authed(invitee.token).get(`/v1/trips/${trip.id}`).expect(404);
  });

  it('claiming a placeholder transfers its ledger history (FR-SPLIT-03)', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const invitee = await createUser();

    const { body: placeholder } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/participants`)
      .send({ displayName: 'Devon' })
      .expect(201);

    // Give the placeholder a balance before they have an account.
    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send({
        description: 'Dinner',
        amountMinor: '10000',
        currency: 'INR',
        payments: [{ participantId: trip.ownerParticipantId, amountMinor: '10000' }],
        split: {
          method: 'EQUAL',
          participantIds: [trip.ownerParticipantId, placeholder.id],
        },
      })
      .expect(201);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/invites`)
      .send({ emails: [invitee.email], claimsParticipantId: placeholder.id })
      .expect(201);

    const token = await issueToken(trip.id, invitee.email);
    await authed(invitee.token).post('/v1/invites/accept').send({ token }).expect(200);

    const { body: participants } = await authed(invitee.token).get(
      `/v1/trips/${trip.id}/participants`,
    );

    // No NEW participant was created — the placeholder was claimed.
    expect(participants.items).toHaveLength(2);
    const claimed = participants.items.find(
      (p: { id: string }) => p.id === placeholder.id,
    );
    expect(claimed.isPlaceholder).toBe(false);
    expect(claimed.userId).toBe(invitee.id);

    // And the balance moved with them, still summing to zero.
    const { body: balances } = await authed(invitee.token).get(`/v1/trips/${trip.id}/balances`);
    const net = balances.balances.reduce(
      (sum: bigint, b: { netMinor: string }) => sum + BigInt(b.netMinor),
      0n,
    );
    expect(net).toBe(0n);
    const theirs = balances.balances.find(
      (b: { participantId: string }) => b.participantId === placeholder.id,
    );
    expect(theirs.netMinor).toBe('-5000');
  });

  it('forbids a CONTRIBUTOR from inviting', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const contributor = await addMember(trip.id, 'CONTRIBUTOR');

    await authed(contributor.token)
      .post(`/v1/trips/${trip.id}/invites`)
      .send({ emails: ['x@test.dev'] })
      .expect(403);
  });

  it('revokes a pending invite', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/invites`)
      .send({ emails: ['x@test.dev'] })
      .expect(201);

    const { body: listed } = await authed(owner.token).get(`/v1/trips/${trip.id}/invites`);
    await authed(owner.token)
      .delete(`/v1/trips/${trip.id}/invites/${listed.items[0].id}`)
      .expect(204);

    const { body: after } = await authed(owner.token).get(`/v1/trips/${trip.id}/invites`);
    expect(after.items).toHaveLength(0);
  });
});

describe('comments', () => {
  it('creates, lists, and threads one level deep', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });

    const { body: parent } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/comments`)
      .send({ body: 'Should we book the full course?' })
      .expect(201);

    const { body: reply } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/comments`)
      .send({ body: 'Yes — worth it', parentCommentId: parent.id })
      .expect(201);

    expect(reply.parentCommentId).toBe(parent.id);

    // A reply to a reply is refused rather than silently flattened.
    const { body } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/comments`)
      .send({ body: 'Nested too far', parentCommentId: reply.id })
      .expect(422);
    expect(body.error.message).toMatch(/one level/i);

    const { body: listed } = await authed(owner.token).get(`/v1/trips/${trip.id}/comments`);
    expect(listed.items).toHaveLength(2);
    expect(listed.items[0].authorName).toBeTruthy();
  });

  it('lets a VIEWER comment but not resolve (PRD §8)', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const viewer = await addMember(trip.id, 'VIEWER');

    const { body: comment } = await authed(viewer.token)
      .post(`/v1/trips/${trip.id}/comments`)
      .send({ body: 'Looks lovely' })
      .expect(201);

    await authed(viewer.token)
      .post(`/v1/trips/${trip.id}/comments/${comment.id}/resolve`)
      .send({ resolved: true })
      .expect(403);

    // The owner can.
    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/comments/${comment.id}/resolve`)
      .send({ resolved: true })
      .expect(200);
  });

  it('lets a CONTRIBUTOR resolve only their own thread', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const contributor = await addMember(trip.id, 'CONTRIBUTOR');

    const { body: theirs } = await authed(contributor.token)
      .post(`/v1/trips/${trip.id}/comments`)
      .send({ body: 'Mine' })
      .expect(201);

    const { body: owners } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/comments`)
      .send({ body: 'Theirs' })
      .expect(201);

    await authed(contributor.token)
      .post(`/v1/trips/${trip.id}/comments/${theirs.id}/resolve`)
      .send({ resolved: true })
      .expect(200);

    await authed(contributor.token)
      .post(`/v1/trips/${trip.id}/comments/${owners.id}/resolve`)
      .send({ resolved: true })
      .expect(403);
  });

  it('hides resolved comments unless asked for', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });

    const { body: comment } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/comments`)
      .send({ body: 'Done with this' })
      .expect(201);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/comments/${comment.id}/resolve`)
      .send({ resolved: true })
      .expect(200);

    const { body: hidden } = await authed(owner.token).get(`/v1/trips/${trip.id}/comments`);
    expect(hidden.items).toHaveLength(0);

    const { body: shown } = await authed(owner.token).get(
      `/v1/trips/${trip.id}/comments?includeResolved=true`,
    );
    expect(shown.items).toHaveLength(1);
  });

  it('only the author may edit', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const editor = await addMember(trip.id, 'EDITOR');

    const { body: comment } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/comments`)
      .send({ body: 'Original' })
      .expect(201);

    await authed(editor.token)
      .patch(`/v1/trips/${trip.id}/comments/${comment.id}`)
      .send({ body: 'Hijacked' })
      .expect(403);
  });
});

describe('suggestions (FR-COLLAB-08)', () => {
  async function tripWithDay() {
    const owner = await createUser();
    const { body: trip } = await authed(owner.token)
      .post('/v1/trips')
      .send({ destination: 'Kyoto', startDate: '2026-05-18', endDate: '2026-05-19' })
      .expect(201);
    const { body: canvas } = await authed(owner.token).get(`/v1/trips/${trip.id}/canvas`);
    return { owner, trip, dayId: canvas.days[0].id };
  }

  it('lets a CONTRIBUTOR propose a block for review', async () => {
    const { owner, trip, dayId } = await tripWithDay();
    const contributor = await addMember(trip.id, 'CONTRIBUTOR');

    const { body } = await authed(contributor.token)
      .post(`/v1/trips/${trip.id}/suggestions`)
      .send({
        dayId,
        rationale: 'Heard it is excellent',
        proposedBlock: { type: 'RESTAURANT', title: 'Kikunoi' },
      })
      .expect(201);

    expect(body.status).toBe('PENDING');

    // A Contributor cannot review — that is the whole point of the queue.
    await authed(contributor.token)
      .post(`/v1/trips/${trip.id}/suggestions/${body.id}/review`)
      .send({ decision: 'ACCEPT' })
      .expect(403);

    void owner;
  });

  it('accepting materialises a real block, attributed to the proposer', async () => {
    const { owner, trip, dayId } = await tripWithDay();
    const contributor = await addMember(trip.id, 'CONTRIBUTOR');

    const { body: suggestion } = await authed(contributor.token)
      .post(`/v1/trips/${trip.id}/suggestions`)
      .send({ dayId, proposedBlock: { type: 'RESTAURANT', title: 'Kikunoi' } })
      .expect(201);

    const { body: reviewed } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/suggestions/${suggestion.id}/review`)
      .send({ decision: 'ACCEPT' })
      .expect(200);

    expect(reviewed.status).toBe('ACCEPTED');
    expect(reviewed.createdBlockId).toBeTruthy();

    const { body: canvas } = await authed(owner.token).get(`/v1/trips/${trip.id}/canvas`);
    const created = canvas.days[0].blocks.find(
      (b: { title: string }) => b.title === 'Kikunoi',
    );
    expect(created).toBeTruthy();
    // Attributed to whoever wrote it, not whoever approved it.
    expect(created.createdBy).toBe(contributor.id);
  });

  it('rejecting creates no block and records the reason', async () => {
    const { owner, trip, dayId } = await tripWithDay();

    const { body: suggestion } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/suggestions`)
      .send({ dayId, proposedBlock: { type: 'NOTE', title: 'Maybe not' } })
      .expect(201);

    const { body } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/suggestions/${suggestion.id}/review`)
      .send({ decision: 'REJECT', reason: 'Too far out of the way' })
      .expect(200);

    expect(body.status).toBe('REJECTED');
    expect(body.createdBlockId).toBeNull();
    expect(body.reviewReason).toBe('Too far out of the way');

    const { body: canvas } = await authed(owner.token).get(`/v1/trips/${trip.id}/canvas`);
    expect(canvas.days[0].blocks).toHaveLength(0);
  });

  it('cannot be reviewed twice', async () => {
    const { owner, trip, dayId } = await tripWithDay();

    const { body: suggestion } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/suggestions`)
      .send({ dayId, proposedBlock: { type: 'NOTE', title: 'X' } })
      .expect(201);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/suggestions/${suggestion.id}/review`)
      .send({ decision: 'ACCEPT' })
      .expect(200);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/suggestions/${suggestion.id}/review`)
      .send({ decision: 'REJECT' })
      .expect(422);
  });

  it('requires a day when accepting a suggestion that named none', async () => {
    const { owner, trip } = await tripWithDay();

    const { body: suggestion } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/suggestions`)
      .send({ proposedBlock: { type: 'NOTE', title: 'Somewhere' } })
      .expect(201);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/suggestions/${suggestion.id}/review`)
      .send({ decision: 'ACCEPT' })
      .expect(422);
  });

  it('filters the review queue by status', async () => {
    const { owner, trip, dayId } = await tripWithDay();

    const { body: a } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/suggestions`)
      .send({ dayId, proposedBlock: { type: 'NOTE', title: 'A' } });
    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/suggestions`)
      .send({ dayId, proposedBlock: { type: 'NOTE', title: 'B' } });

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/suggestions/${a.id}/review`)
      .send({ decision: 'ACCEPT' })
      .expect(200);

    const { body } = await authed(owner.token).get(
      `/v1/trips/${trip.id}/suggestions?status=PENDING`,
    );
    expect(body.items).toHaveLength(1);
    expect(body.items[0].proposedBlock.title).toBe('B');
  });
});
