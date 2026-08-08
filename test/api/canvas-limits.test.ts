/**
 * Canvas edge cases and the ceilings that bound them.
 *
 * `canvas.test.ts` covers the happy paths and the headline behaviours. This
 * covers what it does not: the second direction of fork isolation, restore
 * position, the boundaries of every `LIMIT_*`, and whether those limits are
 * actually driven by configuration as PRD D-10 requires rather than by literals
 * that make the env vars decorative.
 *
 * Ceiling tests fill up to the limit in parallel batches but always take the
 * last two steps — the one that must succeed and the one that must fail —
 * sequentially, because the service counts and inserts inside a transaction and
 * concurrent writers could otherwise both see room for the same slot.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { authed } from '../support/api';
import { closeTestDatabase, resetDatabase } from '../support/db';
import { createUser } from '../support/factories';
import { limits } from '../../src/platform/config/env';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

/** A trip with one day and one block on it. */
async function scaffold() {
  const owner = await createUser();

  const { body: trip } = await authed(owner.token)
    .post('/v1/trips')
    .send({ destination: 'Kyoto', startDate: '2026-05-18', endDate: '2026-05-20' })
    .expect(201);

  const { body: canvas } = await authed(owner.token)
    .get(`/v1/trips/${trip.id}/canvas`)
    .expect(200);

  return { owner, trip, canvas, mainVariantId: canvas.variant.id as string };
}

const inBatches = async (
  total: number,
  make: (index: number) => Promise<unknown>,
  size = 25,
): Promise<void> => {
  for (let start = 0; start < total; start += size) {
    const count = Math.min(size, total - start);
    await Promise.all(Array.from({ length: count }, (_, offset) => make(start + offset)));
  }
};

describe('fork isolation runs both ways (FR-VAR-03/04)', () => {
  it('leaves the fork untouched when the ORIGINAL is edited', async () => {
    const { owner, trip, canvas, mainVariantId } = await scaffold();
    const day = canvas.days[0];

    const { body: original } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/days/${day.id}/blocks`)
      .send({ type: 'ACTIVITY', title: 'Kiyomizu-dera' })
      .expect(201);

    const { body: fork } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants`)
      .send({ name: 'Rainy day', forkFromVariantId: mainVariantId })
      .expect(201);

    // `canvas.test.ts` proves editing the fork leaves the original alone. The
    // reverse is the same claim from the other side, and a shared row would
    // fail exactly one of the two.
    await authed(owner.token)
      .patch(`/v1/trips/${trip.id}/blocks/${original.id}`)
      .send({ version: original.version, title: 'Fushimi Inari instead' })
      .expect(200);

    await authed(owner.token)
      .delete(`/v1/trips/${trip.id}/blocks/${original.id}`)
      .expect(204);

    const { body: forked } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas?variantId=${fork.id}`)
      .expect(200);

    const titles = forked.days.flatMap((d: { blocks: { title: string }[] }) =>
      d.blocks.map((b) => b.title),
    );
    expect(titles, 'editing the original reached into the fork').toStrictEqual([
      'Kiyomizu-dera',
    ]);
  });

  it('forks a fork, and the grandchild diverges from both', async () => {
    const { owner, trip, canvas, mainVariantId } = await scaffold();

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/days/${canvas.days[0].id}/blocks`)
      .send({ type: 'NOTE', title: 'Original' })
      .expect(201);

    const { body: child } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants`)
      .send({ name: 'Child', forkFromVariantId: mainVariantId })
      .expect(201);

    const { body: grandchild } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants`)
      .send({ name: 'Grandchild', forkFromVariantId: child.id })
      .expect(201);

    expect(grandchild.blockCount).toBe(1);
    expect(grandchild.forkedFromId).toBe(child.id);

    const { body: view } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas?variantId=${grandchild.id}`)
      .expect(200);

    const grandchildBlock = view.days[0].blocks[0];
    await authed(owner.token)
      .patch(`/v1/trips/${trip.id}/blocks/${grandchildBlock.id}`)
      .send({ version: grandchildBlock.version, title: 'Diverged' })
      .expect(200);

    for (const [variantId, expected] of [
      [mainVariantId, 'Original'],
      [child.id, 'Original'],
      [grandchild.id, 'Diverged'],
    ] as const) {
      const { body } = await authed(owner.token)
        .get(`/v1/trips/${trip.id}/canvas?variantId=${variantId}`)
        .expect(200);
      expect(body.days[0].blocks[0].title).toBe(expected);
    }
  });
});

describe('restore puts a block back where it was (FR-BLK-09)', () => {
  it('restores to its original position, not to the end of the day', async () => {
    const { owner, trip, canvas } = await scaffold();
    const day = canvas.days[0];

    const created: { id: string }[] = [];
    for (const title of ['First', 'Second', 'Third']) {
      const { body } = await authed(owner.token)
        .post(`/v1/trips/${trip.id}/days/${day.id}/blocks`)
        .send({ type: 'NOTE', title })
        .expect(201);
      created.push(body);
    }

    // Delete the middle one and put it back. An undo that silently reorders the
    // day is not an undo — FR-UNDO-01 promises the prior state.
    await authed(owner.token)
      .delete(`/v1/trips/${trip.id}/blocks/${created[1]!.id}`)
      .expect(204);
    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/blocks/${created[1]!.id}/restore`)
      .expect(204);

    const { body } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas`)
      .expect(200);

    expect(
      body.days[0].blocks.map((b: { title: string }) => b.title),
      'restoring a block moved it out of its original position',
    ).toStrictEqual(['First', 'Second', 'Third']);
  });
});

describe('day edge cases', () => {
  it('deletes the only day, leaving an empty but usable variant', async () => {
    const owner = await createUser();
    const { body: trip } = await authed(owner.token)
      .post('/v1/trips')
      .send({ destination: 'Kyoto', startDate: '2026-05-18', endDate: '2026-05-18' })
      .expect(201);

    const { body: canvas } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas`)
      .expect(200);
    expect(canvas.days).toHaveLength(1);

    await authed(owner.token)
      .delete(`/v1/trips/${trip.id}/days/${canvas.days[0].id}`)
      .expect(204);

    const { body: after } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas`)
      .expect(200);
    expect(after.days).toStrictEqual([]);

    // And a day can be added back, so the variant is not left in a dead state.
    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants/${canvas.variant.id}/days`)
      .send({ title: 'Day one, again' })
      .expect(201);
  });

  it('refuses a reorder naming the same day twice', async () => {
    const { owner, trip, canvas, mainVariantId } = await scaffold();
    const [first] = canvas.days;

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants/${mainVariantId}/days/reorder`)
      .send({ orderedDayIds: [first.id, first.id, first.id] })
      .expect(422);
  });

  it('refuses a reorder naming a day from another variant', async () => {
    const { owner, trip, canvas, mainVariantId } = await scaffold();

    const { body: fork } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants`)
      .send({ name: 'Fork', forkFromVariantId: mainVariantId })
      .expect(201);

    const { body: forkView } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas?variantId=${fork.id}`)
      .expect(200);

    const mixed = [
      canvas.days[0].id,
      canvas.days[1].id,
      forkView.days[0].id,
    ];

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants/${mainVariantId}/days/reorder`)
      .send({ orderedDayIds: mixed })
      .expect(422);
  });
});

describe('blocks', () => {
  it('refuses to move a block into a different variant of the same trip', async () => {
    const { owner, trip, canvas, mainVariantId } = await scaffold();

    const { body: block } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/days/${canvas.days[0].id}/blocks`)
      .send({ type: 'NOTE', title: 'Stays put' })
      .expect(201);

    const { body: fork } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants`)
      .send({ name: 'Fork', forkFromVariantId: mainVariantId })
      .expect(201);

    const { body: forkView } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas?variantId=${fork.id}`)
      .expect(200);

    // A block cannot jump between parallel plans: the two variants are
    // supposed to be independent, and a move would make one edit the other.
    const response = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/blocks/${block.id}/move`)
      .send({ toDayId: forkView.days[1].id });

    expect([400, 404, 422]).toContain(response.status);

    const { body: after } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas`)
      .expect(200);
    expect(after.days[0].blocks).toHaveLength(1);
  });

  it('accepts every block type the contract declares, and refuses an unknown one', async () => {
    const { owner, trip, canvas } = await scaffold();
    const day = canvas.days[0];

    const TYPES = [
      'ACCOMMODATION',
      'TRANSPORT',
      'RESTAURANT',
      'TICKET',
      'ACTIVITY',
      'NOTE',
    ];

    for (const type of TYPES) {
      await authed(owner.token)
        .post(`/v1/trips/${trip.id}/days/${day.id}/blocks`)
        .send({ type, title: type })
        .expect(201);
    }

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/days/${day.id}/blocks`)
      .send({ type: 'TELEPORT', title: 'Not a thing' })
      .expect(400);
  });
});

describe('readiness is a real number (FR-DASH-07)', () => {
  it('reports the exact rounded percentage of booked bookable blocks', async () => {
    const { owner, trip, canvas } = await scaffold();
    const day = canvas.days[0];

    // Three bookable, one booked ⇒ 33%. Plus a NOTE, which is not bookable and
    // must not dilute the denominator.
    const bookable = ['ACCOMMODATION', 'TRANSPORT', 'RESTAURANT'];
    const created: { id: string; version: number }[] = [];
    for (const type of bookable) {
      const { body } = await authed(owner.token)
        .post(`/v1/trips/${trip.id}/days/${day.id}/blocks`)
        .send({ type, title: type })
        .expect(201);
      created.push(body);
    }

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/days/${day.id}/blocks`)
      .send({ type: 'NOTE', title: 'Not bookable' })
      .expect(201);

    await authed(owner.token)
      .patch(`/v1/trips/${trip.id}/blocks/${created[0]!.id}`)
      .send({ version: created[0]!.version, isConfirmed: true })
      .expect(200);

    const { body } = await authed(owner.token).get(`/v1/trips/${trip.id}`).expect(200);
    expect(body.readinessPct, 'readiness must be 1 of 3 bookable blocks').toBe(33);
  });

  it('reports 100% for a completed trip whatever its blocks say', async () => {
    const { owner, trip, canvas } = await scaffold();

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/days/${canvas.days[0].id}/blocks`)
      .send({ type: 'ACCOMMODATION', title: 'Never booked' })
      .expect(201);

    const { body: current } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}`)
      .expect(200);

    await authed(owner.token)
      .patch(`/v1/trips/${trip.id}`)
      .send({ version: current.version, status: 'COMPLETED' })
      .expect(200);

    const { body } = await authed(owner.token).get(`/v1/trips/${trip.id}`).expect(200);
    expect(body.readinessPct).toBe(100);
  });
});

describe('every ceiling is enforced, and driven by configuration (PRD D-10)', () => {
  it('refuses the block that would exceed LIMIT_BLOCKS_PER_DAY', async () => {
    const { owner, trip, canvas } = await scaffold();
    const day = canvas.days[0];
    const ceiling = limits.blocksPerDay;

    // Fill to one below the ceiling concurrently, then take the last two steps
    // one at a time so the count the service reads is unambiguous.
    await inBatches(ceiling - 1, (index) =>
      authed(owner.token)
        .post(`/v1/trips/${trip.id}/days/${day.id}/blocks`)
        .send({ type: 'NOTE', title: `Block ${index}` })
        .expect(201),
    );

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/days/${day.id}/blocks`)
      .send({ type: 'NOTE', title: 'The last one that fits' })
      .expect(201);

    const { body } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/days/${day.id}/blocks`)
      .send({ type: 'NOTE', title: 'One too many' })
      .expect(422);

    expect(body.error.code).toBe('LIMIT_EXCEEDED');
  });

  it('refuses the day that would exceed LIMIT_DAYS_PER_VARIANT', async () => {
    const { owner, trip, canvas, mainVariantId } = await scaffold();
    const ceiling = limits.daysPerVariant;
    const existing = canvas.days.length;

    // Filled in parallel batches: day numbering is serialised by a row lock on
    // the variant, so concurrent appends no longer collide. This test would
    // have had to run one at a time before that fix.
    await inBatches(ceiling - existing - 1, (index) =>
      authed(owner.token)
        .post(`/v1/trips/${trip.id}/variants/${mainVariantId}/days`)
        .send({ title: `Day ${index}` })
        .expect(201),
    );

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants/${mainVariantId}/days`)
      .send({ title: 'The last one that fits' })
      .expect(201);

    const { body } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants/${mainVariantId}/days`)
      .send({ title: 'One too many' })
      .expect(422);

    expect(body.error.code).toBe('LIMIT_EXCEEDED');
  });

  it('never lets two concurrent day appends corrupt the numbering', async () => {
    const { owner, trip, mainVariantId } = await scaffold();

    // Four collaborators press "Add a day" at the same moment.
    //
    // Day numbers come from `count + 1` read inside the transaction, so under
    // READ COMMITTED every one of these read the same count and inserted the
    // same number — colliding on `days_variant_number_uq`. Nothing was ever
    // corrupted, because the constraint caught it, but the losers got an
    // opaque DOMAIN_RULE_VIOLATION naming a database index. With real-time
    // co-editing (FR-COLLAB-06) this is ordinary use, not an edge case.
    //
    // A row lock on the variant now serialises numbering, so all four land.
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        authed(owner.token)
          .post(`/v1/trips/${trip.id}/variants/${mainVariantId}/days`)
          .send({ title: `Concurrent ${i}` }),
      ),
    );

    const statuses = results.map((r) => r.status);
    expect(
      statuses,
      `concurrent appends were refused: ${JSON.stringify(results.map((r) => r.body))}`,
    ).toStrictEqual([201, 201, 201, 201]);

    const { body } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas`)
      .expect(200);

    const numbers = body.days.map((d: { dayNumber: number }) => d.dayNumber);
    expect(
      numbers,
      'concurrent appends left a gap or a duplicate in the day numbering',
    ).toStrictEqual([...numbers].sort((a: number, b: number) => a - b));
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('caps photos per block at the CONFIGURED limit, not a hardcoded one', async () => {
    const { owner, trip, canvas } = await scaffold();

    const { body: block } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/days/${canvas.days[0].id}/blocks`)
      .send({ type: 'ACTIVITY', title: 'Photo dump' })
      .expect(201);

    const uuid = (n: number): string =>
      `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

    const atLimit = Array.from({ length: limits.photosPerBlock }, (_, i) => uuid(i));

    await authed(owner.token)
      .patch(`/v1/trips/${trip.id}/blocks/${block.id}`)
      .send({ version: block.version, sections: { photos: atLimit } })
      .expect(200);

    // FR-SEC-03 caps photos per block, and PRD D-10 says every such ceiling is
    // configuration rather than a constant. A literal in the Zod schema
    // enforces the number but makes LIMIT_PHOTOS_PER_BLOCK decorative: change
    // the env var and nothing moves.
    const overLimit = [...atLimit, uuid(limits.photosPerBlock)];

    await authed(owner.token)
      .patch(`/v1/trips/${trip.id}/blocks/${block.id}`)
      .send({ version: block.version + 1, sections: { photos: overLimit } })
      .expect(400);
  });
});
