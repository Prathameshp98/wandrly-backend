/**
 * Canvas API tests — variants, days, blocks, sections.
 *
 * The forking tests matter most: the prototype shared one day tree across every
 * variant, so "fork a plan and edit it independently" has never worked anywhere
 * in this product. These are the first assertions that it does.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { authed } from '../support/api';
import { closeTestDatabase, resetDatabase } from '../support/db';
import { addMember, createUser } from '../support/factories';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  // Each file owns its pool under `isolate: true`, so each closes its own.
  await closeTestDatabase();
});

/** A trip with 3 days, and one block on day 1. */
async function scaffold() {
  const owner = await createUser();

  const { body: trip } = await authed(owner.token)
    .post('/v1/trips')
    .send({ destination: 'Kyoto', startDate: '2026-05-18', endDate: '2026-05-20' })
    .expect(201);

  const { body: canvas } = await authed(owner.token)
    .get(`/v1/trips/${trip.id}/canvas`)
    .expect(200);

  const { body: block } = await authed(owner.token)
    .post(`/v1/trips/${trip.id}/days/${canvas.days[0].id}/blocks`)
    .send({ type: 'ACTIVITY', title: 'Kiyomizu-dera', timeLabel: '06:00 → 08:30' })
    .expect(201);

  return { owner, trip, canvas, mainVariantId: canvas.variant.id, block };
}

describe('GET /canvas', () => {
  it('returns the main variant with its days and blocks', async () => {
    const { owner, trip } = await scaffold();

    const { body } = await authed(owner.token).get(`/v1/trips/${trip.id}/canvas`).expect(200);

    expect(body.variant.isMain).toBe(true);
    expect(body.days).toHaveLength(3);
    expect(body.days[0].blocks).toHaveLength(1);
    expect(body.days[0].blocks[0].title).toBe('Kiyomizu-dera');
    expect(body.days[0].dayNumber).toBe(1);
  });
});

describe('variant forking (FR-VAR-03/04) — the product differentiator', () => {
  it('deep-copies the day and block tree', async () => {
    const { owner, trip, mainVariantId } = await scaffold();

    const { body: fork } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants`)
      .send({ name: 'Budget run', forkFromVariantId: mainVariantId })
      .expect(201);

    expect(fork.isMain).toBe(false);
    expect(fork.forkedFromId).toBe(mainVariantId);
    expect(fork.dayCount).toBe(3);
    expect(fork.blockCount).toBe(1);
  });

  it('lets the fork diverge without touching the original', async () => {
    // This is the assertion the prototype could never have passed.
    const { owner, trip, mainVariantId } = await scaffold();

    const { body: fork } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants`)
      .send({ name: 'Budget run', forkFromVariantId: mainVariantId })
      .expect(201);

    const { body: forkCanvas } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas?variantId=${fork.id}`)
      .expect(200);

    // Edit the fork's copy of the block.
    const forkBlock = forkCanvas.days[0].blocks[0];
    await authed(owner.token)
      .patch(`/v1/trips/${trip.id}/blocks/${forkBlock.id}`)
      .send({ version: forkBlock.version, title: 'Cheaper temple' })
      .expect(200);

    // Add a day to the fork only.
    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants/${fork.id}/days`)
      .send({ title: 'Extra budget day' })
      .expect(201);

    const { body: mainAfter } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas?variantId=${mainVariantId}`)
      .expect(200);

    expect(mainAfter.days).toHaveLength(3); // unchanged
    expect(mainAfter.days[0].blocks[0].title).toBe('Kiyomizu-dera'); // unchanged

    const { body: forkAfter } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas?variantId=${fork.id}`)
      .expect(200);

    expect(forkAfter.days).toHaveLength(4);
    expect(forkAfter.days[0].blocks[0].title).toBe('Cheaper temple');
  });

  it('starts fresh when no source is given', async () => {
    const { owner, trip } = await scaffold();

    const { body } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants`)
      .send({ name: 'From scratch' })
      .expect(201);

    expect(body.dayCount).toBe(0);
    expect(body.forkedFromId).toBeNull();
  });

  it('enforces the variant ceiling (FR-VAR-08)', async () => {
    const { owner, trip } = await scaffold();

    // One main already exists; the limit is 8.
    for (let i = 2; i <= 8; i += 1) {
      await authed(owner.token)
        .post(`/v1/trips/${trip.id}/variants`)
        .send({ name: `V${i}` })
        .expect(201);
    }

    const { body } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants`)
      .send({ name: 'One too many' })
      .expect(422);

    expect(body.error.code).toBe('LIMIT_EXCEEDED');
  });

  it('cannot fork a variant from another trip', async () => {
    const a = await scaffold();
    const b = await scaffold();

    await authed(a.owner.token)
      .post(`/v1/trips/${a.trip.id}/variants`)
      .send({ name: 'Cross-trip', forkFromVariantId: b.mainVariantId })
      .expect(404);
  });
});

describe('promote and delete variants', () => {
  it('promotes a fork and keeps the previous main (FR-VAR-06)', async () => {
    const { owner, trip, mainVariantId } = await scaffold();

    const { body: fork } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants`)
      .send({ name: 'Budget run', forkFromVariantId: mainVariantId })
      .expect(201);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants/${fork.id}/promote`)
      .expect(204);

    const { body } = await authed(owner.token).get(`/v1/trips/${trip.id}/variants`);
    const main = body.items.filter((v: { isMain: boolean }) => v.isMain);

    expect(main).toHaveLength(1);
    expect(main[0].id).toBe(fork.id);
    // The old main survives as an ordinary variant.
    expect(body.items).toHaveLength(2);
  });

  it('refuses to delete the main variant (FR-VAR-07)', async () => {
    const { owner, trip, mainVariantId } = await scaffold();

    const { body } = await authed(owner.token)
      .delete(`/v1/trips/${trip.id}/variants/${mainVariantId}`)
      .expect(422);

    expect(body.error.message).toMatch(/Promote another/);
  });

  it('only the OWNER may promote (PRD §8)', async () => {
    const { owner, trip, mainVariantId } = await scaffold();
    const editor = await addMember(trip.id, 'EDITOR');

    const { body: fork } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants`)
      .send({ name: 'Fork', forkFromVariantId: mainVariantId })
      .expect(201);

    // An Editor may create variants…
    await authed(editor.token)
      .post(`/v1/trips/${trip.id}/variants`)
      .send({ name: 'Editor fork' })
      .expect(201);

    // …but not promote one.
    await authed(editor.token)
      .post(`/v1/trips/${trip.id}/variants/${fork.id}/promote`)
      .expect(403);
  });
});

describe('days', () => {
  it('duplicates a day immediately after the source (FR-DAY-05)', async () => {
    // The prototype appended the copy to the end, which is wrong for a
    // chronological itinerary.
    const { owner, trip, canvas } = await scaffold();
    const day1 = canvas.days[0];

    await authed(owner.token)
      .patch(`/v1/trips/${trip.id}/days/${day1.id}`)
      .send({ version: day1.version, title: 'Higashiyama temples' })
      .expect(200);

    const { body: copy } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/days/${day1.id}/duplicate`)
      .expect(201);

    expect(copy.dayNumber).toBe(2); // not 4

    const { body } = await authed(owner.token).get(`/v1/trips/${trip.id}/canvas`);
    expect(body.days.map((d: { dayNumber: number }) => d.dayNumber)).toStrictEqual([1, 2, 3, 4]);
    expect(body.days[1].title).toMatch(/copy/);
    // Blocks come with it.
    expect(body.days[1].blocks).toHaveLength(1);
  });

  it('renumbers contiguously after a delete (FR-DAY-04)', async () => {
    const { owner, trip, canvas } = await scaffold();

    await authed(owner.token)
      .delete(`/v1/trips/${trip.id}/days/${canvas.days[1].id}`)
      .expect(204);

    const { body } = await authed(owner.token).get(`/v1/trips/${trip.id}/canvas`);
    expect(body.days.map((d: { dayNumber: number }) => d.dayNumber)).toStrictEqual([1, 2]);
  });

  it('reorders days (FR-DAY-06)', async () => {
    const { owner, trip, canvas, mainVariantId } = await scaffold();
    const reversed = [...canvas.days].reverse().map((d: { id: string }) => d.id);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants/${mainVariantId}/days/reorder`)
      .send({ orderedDayIds: reversed })
      .expect(204);

    const { body } = await authed(owner.token).get(`/v1/trips/${trip.id}/canvas`);
    expect(body.days[0].id).toBe(reversed[0]);
    expect(body.days.map((d: { dayNumber: number }) => d.dayNumber)).toStrictEqual([1, 2, 3]);
  });

  it('rejects a partial reorder', async () => {
    const { owner, trip, canvas, mainVariantId } = await scaffold();

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants/${mainVariantId}/days/reorder`)
      .send({ orderedDayIds: [canvas.days[0].id] })
      .expect(422);
  });

  it('rejects a CONTRIBUTOR managing days', async () => {
    const { trip, canvas } = await scaffold();
    const contributor = await addMember(trip.id, 'CONTRIBUTOR');

    await authed(contributor.token)
      .delete(`/v1/trips/${trip.id}/days/${canvas.days[0].id}`)
      .expect(403);
  });
});

describe('blocks', () => {
  it('moves a block to another day at a chosen index (FR-BLK-07/08)', async () => {
    const { owner, trip, canvas, block } = await scaffold();
    const day2 = canvas.days[1];

    // Give day 2 two existing blocks.
    for (const title of ['First', 'Second']) {
      await authed(owner.token)
        .post(`/v1/trips/${trip.id}/days/${day2.id}/blocks`)
        .send({ type: 'NOTE', title })
        .expect(201);
    }

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/blocks/${block.id}/move`)
      .send({ toDayId: day2.id, toIndex: 1 })
      .expect(204);

    const { body } = await authed(owner.token).get(`/v1/trips/${trip.id}/canvas`);
    expect(body.days[0].blocks).toHaveLength(0);
    expect(body.days[1].blocks.map((b: { title: string }) => b.title)).toStrictEqual([
      'First',
      'Kiyomizu-dera',
      'Second',
    ]);
  });

  it('reorders blocks within one day', async () => {
    const { owner, trip, canvas, block } = await scaffold();
    const day1 = canvas.days[0];

    const { body: second } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/days/${day1.id}/blocks`)
      .send({ type: 'NOTE', title: 'Second' })
      .expect(201);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/days/${day1.id}/blocks/reorder`)
      .send({ orderedBlockIds: [second.id, block.id] })
      .expect(204);

    const { body } = await authed(owner.token).get(`/v1/trips/${trip.id}/canvas`);
    expect(body.days[0].blocks.map((b: { title: string }) => b.title)).toStrictEqual([
      'Second',
      'Kiyomizu-dera',
    ]);
  });

  it('soft-deletes and restores', async () => {
    const { owner, trip, block } = await scaffold();

    await authed(owner.token).delete(`/v1/trips/${trip.id}/blocks/${block.id}`).expect(204);
    let { body } = await authed(owner.token).get(`/v1/trips/${trip.id}/canvas`);
    expect(body.days[0].blocks).toHaveLength(0);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/blocks/${block.id}/restore`)
      .expect(204);
    ({ body } = await authed(owner.token).get(`/v1/trips/${trip.id}/canvas`));
    expect(body.days[0].blocks).toHaveLength(1);
  });

  it('rejects a stale version', async () => {
    const { owner, trip, block } = await scaffold();

    await authed(owner.token)
      .patch(`/v1/trips/${trip.id}/blocks/${block.id}`)
      .send({ version: block.version, title: 'First edit' })
      .expect(200);

    await authed(owner.token)
      .patch(`/v1/trips/${trip.id}/blocks/${block.id}`)
      .send({ version: block.version, title: 'Stale edit' })
      .expect(409);
  });

  // The per-day block ceiling is asserted for real in `canvas-limits.test.ts`,
  // by filling a day to the limit and requiring the next insert to be refused.
  // What stood here asserted that a day holding one block held fewer than 200 —
  // which passes just as happily when no ceiling exists at all.

  it('refuses to move a block into another trip', async () => {
    const a = await scaffold();
    const b = await scaffold();

    await authed(a.owner.token)
      .post(`/v1/trips/${a.trip.id}/blocks/${a.block.id}/move`)
      .send({ toDayId: b.canvas.days[0].id })
      .expect(404);
  });
});

describe('contributor ownership (PRD §8 "own only")', () => {
  it('lets a Contributor edit their own block but not someone else’s', async () => {
    const { owner, trip, canvas, block } = await scaffold();
    const contributor = await addMember(trip.id, 'CONTRIBUTOR');

    const { body: theirs } = await authed(contributor.token)
      .post(`/v1/trips/${trip.id}/days/${canvas.days[0].id}/blocks`)
      .send({ type: 'NOTE', title: 'My suggestion' })
      .expect(201);

    await authed(contributor.token)
      .patch(`/v1/trips/${trip.id}/blocks/${theirs.id}`)
      .send({ version: theirs.version, title: 'My edit' })
      .expect(200);

    // The owner's block is off limits.
    await authed(contributor.token)
      .patch(`/v1/trips/${trip.id}/blocks/${block.id}`)
      .send({ version: block.version, title: 'Not allowed' })
      .expect(403);

    void owner;
  });
});

describe('block sections (FR-SEC-*)', () => {
  it('round-trips every section type', async () => {
    const { owner, trip, canvas } = await scaffold();

    const sections = {
      notes: 'Beat the school groups',
      map: { lat: 34.9948, lng: 135.785, name: 'Kiyomizu-dera' },
      link: {
        url: 'https://japan-guide.com/kiyomizu',
        host: 'japan-guide.com',
        title: 'Kiyomizu-dera guide',
        desc: 'Opening hours and access',
      },
      cost: { amountMinor: '40000', currency: 'JPY', per: 'pp' as const, splitCount: 3 },
    };

    const { body } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/days/${canvas.days[0].id}/blocks`)
      .send({ type: 'ACTIVITY', title: 'Temple', sections })
      .expect(201);

    expect(body.sections.notes).toBe(sections.notes);
    expect(body.sections.map.name).toBe('Kiyomizu-dera');
    expect(body.sections.cost.amountMinor).toBe('40000');
  });

  it('encrypts booking details at rest but returns them decrypted', async () => {
    const { owner, trip, canvas } = await scaffold();

    const { body } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/days/${canvas.days[0].id}/blocks`)
      .send({
        type: 'TRANSPORT',
        title: 'Mumbai → Kansai',
        sections: {
          booking: [
            { key: 'Confirmation', value: 'M8X42L' },
            { key: 'Seats', value: '14A · 14B' },
          ],
        },
      })
      .expect(201);

    // The API returns plaintext to an authorized caller…
    expect(body.sections.booking[0].value).toBe('M8X42L');

    // …but the stored value is ciphertext (FR-NFR-SEC-02).
    const { db } = await import('../support/db');
    const { sql } = await import('drizzle-orm');
    const raw = await db.execute<{ sections: unknown }>(
      sql`select sections from blocks where id = ${body.id}`,
    );
    const stored = JSON.stringify(raw.rows?.[0]?.sections);
    expect(stored).not.toContain('M8X42L');
    expect(stored).toContain('enc:v1:');
  });

  it('rejects an unknown section key rather than storing it unvalidated', async () => {
    const { owner, trip, canvas } = await scaffold();

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/days/${canvas.days[0].id}/blocks`)
      .send({ type: 'NOTE', title: 'X', sections: { bogus: 'value' } })
      .expect(400);
  });

  it('survives a fork with booking details intact', async () => {
    const { owner, trip, canvas, mainVariantId } = await scaffold();

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/days/${canvas.days[0].id}/blocks`)
      .send({
        type: 'ACCOMMODATION',
        title: 'Ryokan',
        sections: { booking: [{ key: 'Confirmation', value: 'YSR-2026' }] },
      })
      .expect(201);

    const { body: fork } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants`)
      .send({ name: 'Fork', forkFromVariantId: mainVariantId })
      .expect(201);

    const { body } = await authed(owner.token).get(
      `/v1/trips/${trip.id}/canvas?variantId=${fork.id}`,
    );

    const copied = body.days[0].blocks.find(
      (b: { title: string }) => b.title === 'Ryokan',
    );
    expect(copied.sections.booking[0].value).toBe('YSR-2026');
  });
});
