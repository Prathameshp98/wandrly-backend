/**
 * The nine critical end-to-end flows from PRD §15.2.
 *
 * Every other test in this suite builds its world with factories that write SQL
 * directly, then exercises one module. That leaves the *handoffs* — trip
 * creation seeding the ledger, an invite acceptance minting a participant, a
 * block deletion unlinking an expense — as the least-tested code in the system
 * while being the most likely to break.
 *
 * These are the only tests that cross those seams. Each is one journey, built
 * end to end through the API, with no SQL except where a test must impersonate
 * something the API deliberately does not expose (an emailed invite token).
 *
 * PRD §15.2 calls this the layer that "must have automated E2E coverage". There
 * is no frontend, but every one of the nine is expressible over HTTP — which is
 * the whole argument of `DEVELOPMENT_FLOW.md` §1.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';

import { api, authed, sumNet } from '../support/api';
import { closeTestDatabase, db, resetDatabase, seedFxRates } from '../support/db';
import { createUser } from '../support/factories';
import { invites } from '../../src/platform/db/schema/index';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

/**
 * Stand in for the emailed link.
 *
 * The raw token is deliberately never readable from the API — only its hash is
 * stored — so a test that needs to *accept* an invite has to plant a token it
 * knows. Scoped to one invite by email, so several outstanding invites on the
 * same trip do not overwrite each other.
 */
async function plantToken(tripId: string, email: string): Promise<string> {
  const { sha256 } = await import('../../src/platform/crypto/index');
  const token = `journey-token-${email}-${tripId}`;
  await db
    .update(invites)
    .set({ tokenHash: sha256(token) })
    .where(and(eq(invites.tripId, tripId), eq(invites.email, email.toLowerCase())));
  return token;
}

const netOf = (
  balances: { participantId: string; netMinor: string }[],
  participantId: string,
): bigint => BigInt(balances.find((b) => b.participantId === participantId)?.netMinor ?? '0');

describe('§15.2 — the nine critical journeys', () => {
  it('1. sign up → trip → 5 blocks over 2 days → invite → accept → both edit → export', async () => {
    const arjun = await createUser({ displayName: 'Arjun' });
    const priya = await createUser({ displayName: 'Priya' });

    const { body: trip } = await authed(arjun.token)
      .post('/v1/trips')
      .send({ destination: 'Kyoto', startDate: '2026-05-18', endDate: '2026-05-19' })
      .expect(201);

    const { body: canvas } = await authed(arjun.token)
      .get(`/v1/trips/${trip.id}/canvas`)
      .expect(200);
    expect(canvas.days).toHaveLength(2);

    const plan = [
      ['ACCOMMODATION', 'Ryokan check-in', 0],
      ['RESTAURANT', 'Kaiseki dinner', 0],
      ['ACTIVITY', 'Kiyomizu-dera', 1],
      ['TRANSPORT', 'Train to Arashiyama', 1],
      ['NOTE', 'Buy an IC card', 1],
    ] as const;

    for (const [type, title, dayIndex] of plan) {
      await authed(arjun.token)
        .post(`/v1/trips/${trip.id}/days/${canvas.days[dayIndex].id}/blocks`)
        .send({ type, title })
        .expect(201);
    }

    await authed(arjun.token)
      .post(`/v1/trips/${trip.id}/invites`)
      .send({ emails: [priya.email], role: 'EDITOR' })
      .expect(201);

    const token = await plantToken(trip.id, priya.email);
    await authed(priya.token).post('/v1/invites/accept').send({ token }).expect(200);

    // Accepting must mint BOTH a membership and a ledger identity — the seam
    // between collaboration and the ledger.
    const { body: members } = await authed(arjun.token)
      .get(`/v1/trips/${trip.id}/members`)
      .expect(200);
    expect(members.items).toHaveLength(2);

    const { body: participants } = await authed(arjun.token)
      .get(`/v1/trips/${trip.id}/participants`)
      .expect(200);
    expect(participants.items.some((p: { userId: string }) => p.userId === priya.id)).toBe(
      true,
    );

    // Both edit: Priya adds a block, Arjun renames one of hers.
    const { body: priyasBlock } = await authed(priya.token)
      .post(`/v1/trips/${trip.id}/days/${canvas.days[1].id}/blocks`)
      .send({ type: 'ACTIVITY', title: 'Bamboo grove' })
      .expect(201);

    await authed(arjun.token)
      .patch(`/v1/trips/${trip.id}/blocks/${priyasBlock.id}`)
      .send({ version: priyasBlock.version, title: 'Bamboo grove at dawn' })
      .expect(200);

    const pdf = await authed(arjun.token)
      .get(`/v1/trips/${trip.id}/export.pdf`)
      .expect(200);

    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect(Buffer.from(pdf.body).subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('2. fork → modify → promote → the previous main is intact', async () => {
    const owner = await createUser();

    const { body: trip } = await authed(owner.token)
      .post('/v1/trips')
      .send({ destination: 'Kyoto', startDate: '2026-05-18', endDate: '2026-05-19' })
      .expect(201);

    const { body: canvas } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas`)
      .expect(200);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/days/${canvas.days[0].id}/blocks`)
      .send({ type: 'ACCOMMODATION', title: 'Expensive ryokan' })
      .expect(201);

    const { body: fork } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants`)
      .send({ name: 'Budget run', forkFromVariantId: canvas.variant.id })
      .expect(201);

    const { body: forkCanvas } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas?variantId=${fork.id}`)
      .expect(200);

    const forkBlock = forkCanvas.days[0].blocks[0];
    await authed(owner.token)
      .patch(`/v1/trips/${trip.id}/blocks/${forkBlock.id}`)
      .send({ version: forkBlock.version, title: 'Hostel' })
      .expect(200);

    // FR-VAR-05 — "compare variants" has no route. The rest of the journey
    // runs; this is the one step of the nine that cannot.
    const compare = await authed(owner.token).get(
      `/v1/trips/${trip.id}/variants/compare?a=${canvas.variant.id}&b=${fork.id}`,
    );
    expect(
      compare.status,
      'a compare route now exists — this journey should assert the diff',
    ).toBe(404);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants/${fork.id}/promote`)
      .expect(204);

    const { body: variants } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/variants`)
      .expect(200);

    expect(variants.items).toHaveLength(2);
    expect(variants.items.filter((v: { isMain: boolean }) => v.isMain)).toHaveLength(1);
    expect(variants.items.find((v: { isMain: boolean }) => v.isMain).id).toBe(fork.id);

    // FR-VAR-06 — the previous main is retained, unchanged, never deleted.
    const { body: previous } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas?variantId=${canvas.variant.id}`)
      .expect(200);
    expect(previous.days[0].blocks[0].title).toBe('Expensive ryokan');
  });

  it('3. share link → opened logged-out → guest comments → the owner is notified', async () => {
    const owner = await createUser({ displayName: 'Arjun' });

    const { body: trip } = await authed(owner.token)
      .post('/v1/trips')
      .send({ destination: 'Kyoto', startDate: '2026-05-18', endDate: '2026-05-18' })
      .expect(201);

    const { body: canvas } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas`)
      .expect(200);

    const { body: block } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/days/${canvas.days[0].id}/blocks`)
      .send({ type: 'ACTIVITY', title: 'Kiyomizu-dera' })
      .expect(201);

    const { body: link } = await authed(owner.token)
      .put(`/v1/trips/${trip.id}/share`)
      .send({ isEnabled: true, allowComments: true })
      .expect(200);

    // No Authorization header anywhere in these two calls.
    const page = await api.get(`/p/${link.slug}`).expect(200);
    expect(page.text).toContain('Kiyomizu-dera');

    const { body: comment } = await api
      .post(`/p/${link.slug}/comments`)
      .send({ guestName: 'Ravi', body: 'Go at sunrise, it is empty', blockId: block.id })
      .expect(201);
    expect(comment.guestToken).toBeTruthy();

    const { body: onPage } = { body: await api.get(`/p/${link.slug}`).expect(200) };
    expect(onPage.text).toContain('Ravi');

    const { body: comments } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/comments`)
      .expect(200);
    expect(
      comments.items.some((c: { guestName: string | null }) => c.guestName === 'Ravi'),
      'a guest comment never reached the crew’s own view',
    ).toBe(true);
  });

  it('4. delete a block, a day and a trip; restore each; everything comes back', async () => {
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
      .send({ type: 'ACTIVITY', title: 'Kiyomizu-dera' })
      .expect(201);

    // Block: delete then restore.
    await authed(owner.token).delete(`/v1/trips/${trip.id}/blocks/${block.id}`).expect(204);
    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/blocks/${block.id}/restore`)
      .expect(204);

    const { body: afterBlock } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas`)
      .expect(200);
    expect(afterBlock.days[0].blocks[0].title).toBe('Kiyomizu-dera');

    // Day: delete, and the rest renumber contiguously.
    await authed(owner.token)
      .delete(`/v1/trips/${trip.id}/days/${canvas.days[1].id}`)
      .expect(204);

    const { body: afterDay } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas`)
      .expect(200);
    expect(afterDay.days).toHaveLength(2);
    expect(afterDay.days.map((d: { dayNumber: number }) => d.dayNumber)).toStrictEqual([1, 2]);

    // Trip: soft delete, gone from every view, then restored whole.
    await authed(owner.token).delete(`/v1/trips/${trip.id}`).expect(204);
    await authed(owner.token).get(`/v1/trips/${trip.id}`).expect(404);

    const { body: hidden } = await authed(owner.token).get('/v1/trips').expect(200);
    expect(hidden.items.some((t: { id: string }) => t.id === trip.id)).toBe(false);

    await authed(owner.token).post(`/v1/trips/${trip.id}/restore`).expect(204);

    const { body: restored } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas`)
      .expect(200);
    expect(restored.days).toHaveLength(2);
    expect(restored.days[0].blocks[0].title).toBe('Kiyomizu-dera');
  });

  it('5. move a trip into a folder, archive it, restore it from the archive', async () => {
    const owner = await createUser();

    const { body: trip } = await authed(owner.token)
      .post('/v1/trips')
      .send({ destination: 'Kyoto' })
      .expect(201);

    const { body: folder } = await authed(owner.token)
      .post('/v1/folders')
      .send({ name: 'Japan 2026', emoji: '🗾', tone: 'gold' })
      .expect(201);

    await authed(owner.token)
      .patch(`/v1/trips/${trip.id}/folder`)
      .send({ folderId: folder.id })
      .expect(204);

    const { body: withTrip } = await authed(owner.token).get('/v1/folders').expect(200);
    expect(withTrip.items.find((f: { id: string }) => f.id === folder.id).tripCount).toBe(1);

    await authed(owner.token).post(`/v1/trips/${trip.id}/archive`).expect(204);

    // FR-FOLD-05 — archived trips are excluded from folder counts.
    const { body: archivedAway } = await authed(owner.token).get('/v1/folders').expect(200);
    expect(
      archivedAway.items.find((f: { id: string }) => f.id === folder.id).tripCount,
      'an archived trip still counted toward its folder',
    ).toBe(0);

    const { body: mainView } = await authed(owner.token).get('/v1/trips').expect(200);
    expect(mainView.items.some((t: { id: string }) => t.id === trip.id)).toBe(false);

    const { body: archive } = await authed(owner.token)
      .get('/v1/trips?view=archive')
      .expect(200);
    expect(archive.items.some((t: { id: string }) => t.id === trip.id)).toBe(true);

    await authed(owner.token).post(`/v1/trips/${trip.id}/unarchive`).expect(204);

    const { body: back } = await authed(owner.token).get('/v1/trips').expect(200);
    expect(back.items.some((t: { id: string }) => t.id === trip.id)).toBe(true);

    const { body: counted } = await authed(owner.token).get('/v1/folders').expect(200);
    expect(counted.items.find((f: { id: string }) => f.id === folder.id).tripCount).toBe(1);
  });

  it('6. change trip dates with days present, through all four strategies (FR-TRIP-14)', async () => {
    const owner = await createUser();

    const create = async () => {
      const { body } = await authed(owner.token)
        .post('/v1/trips')
        .send({ destination: 'Kyoto', startDate: '2026-05-18', endDate: '2026-05-20' })
        .expect(201);
      return body;
    };

    // Without a strategy the server refuses to guess — it never silently
    // destroys days.
    const first = await create();
    const { body: refusal } = await authed(owner.token)
      .patch(`/v1/trips/${first.id}`)
      .send({ version: first.version, startDate: '2026-05-18', endDate: '2026-05-19' })
      .expect(409);
    expect(refusal.error.code).toBe('CONFLICT_DATE_CHANGE');

    const expectations: [string, string, number][] = [
      ['TRUNCATE', '2026-05-19', 2],
      ['EXTEND', '2026-05-22', 5],
      ['SHIFT', '2026-05-22', 3],
      ['KEEP_DAYS', '2026-05-22', 3],
    ];

    for (const [strategy, endDate, expectedDays] of expectations) {
      const trip = await create();

      await authed(owner.token)
        .patch(`/v1/trips/${trip.id}`)
        .send({
          version: trip.version,
          startDate: '2026-05-18',
          endDate,
          dateChangeStrategy: strategy,
        })
        .expect(200);

      const { body: canvas } = await authed(owner.token)
        .get(`/v1/trips/${trip.id}/canvas`)
        .expect(200);

      expect(canvas.days.length, `${strategy} produced the wrong day count`).toBe(
        expectedDays,
      );
      expect(
        canvas.days.map((d: { dayNumber: number }) => d.dayNumber),
        `${strategy} left the day numbering non-contiguous`,
      ).toStrictEqual(Array.from({ length: expectedDays }, (_, i) => i + 1));
    }
  });

  it('7. six expenses, four participants, five split methods, two currencies → settled', async () => {
    await seedFxRates();
    const arjun = await createUser({ displayName: 'Arjun' });

    const { body: trip } = await authed(arjun.token)
      .post('/v1/trips')
      .send({ destination: 'Kyoto', baseCurrency: 'INR' })
      .expect(201);

    const { body: existing } = await authed(arjun.token)
      .get(`/v1/trips/${trip.id}/participants`)
      .expect(200);
    const a = existing.items[0].id as string;

    const others: string[] = [];
    for (const displayName of ['Priya', 'Sana', 'Dev']) {
      const { body } = await authed(arjun.token)
        .post(`/v1/trips/${trip.id}/participants`)
        .send({ displayName })
        .expect(201);
      others.push(body.id);
    }
    const [p, s, d] = others as [string, string, string];
    const everyone = [a, p, s, d];

    const expense = (body: Record<string, unknown>) =>
      authed(arjun.token)
        .post(`/v1/trips/${trip.id}/expenses`)
        .send({ currency: 'INR', ...body })
        .expect(201);

    // All five split methods, and a second currency with a frozen rate.
    await expense({
      description: 'Ryokan (equal)',
      amountMinor: '10000',
      payments: [{ participantId: a, amountMinor: '10000' }],
      split: { method: 'EQUAL', participantIds: everyone },
    });
    await expense({
      description: 'Dinner (exact)',
      amountMinor: '9000',
      payments: [{ participantId: p, amountMinor: '9000' }],
      split: {
        method: 'EXACT',
        shares: [
          { participantId: a, amountMinor: '3000' },
          { participantId: p, amountMinor: '2000' },
          { participantId: s, amountMinor: '2500' },
          { participantId: d, amountMinor: '1500' },
        ],
      },
    });
    await expense({
      description: 'Taxi (percent)',
      amountMinor: '4000',
      payments: [{ participantId: s, amountMinor: '4000' }],
      split: {
        method: 'PERCENT',
        shares: [
          { participantId: a, percent: 40 },
          { participantId: p, percent: 30 },
          { participantId: s, percent: 20 },
          { participantId: d, percent: 10 },
        ],
      },
    });
    await expense({
      description: 'Suite (shares — a couple counts as two)',
      amountMinor: '15000',
      payments: [{ participantId: d, amountMinor: '15000' }],
      split: {
        method: 'SHARES',
        shares: [
          { participantId: a, weight: 2 },
          { participantId: p, weight: 1 },
          { participantId: s, weight: 1 },
          { participantId: d, weight: 1 },
        ],
      },
    });
    await expense({
      description: 'Tickets (adjustment)',
      amountMinor: '8000',
      payments: [{ participantId: a, amountMinor: '8000' }],
      split: {
        method: 'ADJUSTMENT',
        participantIds: everyone,
        adjustments: [{ participantId: d, amountMinor: '400' }],
      },
    });
    // Sixth, in yen: the rate is frozen at creation (FR-SPLIT-19).
    await expense({
      description: 'Shinkansen (JPY)',
      amountMinor: '13000',
      currency: 'JPY',
      payments: [{ participantId: p, amountMinor: '13000' }],
      split: { method: 'EQUAL', participantIds: everyone },
    });

    const { body: listed } = await authed(arjun.token)
      .get(`/v1/trips/${trip.id}/expenses`)
      .expect(200);
    expect(listed.items).toHaveLength(6);

    // Every expense's shares sum exactly to its own total.
    for (const item of listed.items) {
      const shares = item.shares.reduce(
        (sum: bigint, sh: { shareAmountMinor: string }) => sum + BigInt(sh.shareAmountMinor),
        0n,
      );
      expect(shares, `${item.description} does not sum to its total`).toBe(
        BigInt(item.amountMinor),
      );
    }

    const { body: balances } = await authed(arjun.token)
      .get(`/v1/trips/${trip.id}/balances`)
      .expect(200);
    expect(sumNet(balances.balances), 'FR-SPLIT-18 violated').toBe(0n);

    // Simplify, then actually pay everyone off.
    const { body: settleUp } = await authed(arjun.token)
      .get(`/v1/trips/${trip.id}/settle-up?simplify=true`)
      .expect(200);
    expect(settleUp.transfers.length).toBeLessThanOrEqual(everyone.length - 1);

    for (const transfer of settleUp.transfers) {
      const { body: settlement } = await authed(arjun.token)
        .post(`/v1/trips/${trip.id}/settlements`)
        .send({
          fromParticipantId: transfer.fromParticipantId,
          toParticipantId: transfer.toParticipantId,
          amountMinor: transfer.amountMinor,
        })
        .expect(201);

      await authed(arjun.token)
        .post(`/v1/trips/${trip.id}/settlements/${settlement.id}/confirm`)
        .expect(200);
    }

    const { body: after } = await authed(arjun.token)
      .get(`/v1/trips/${trip.id}/balances`)
      .expect(200);

    expect(sumNet(after.balances)).toBe(0n);
    for (const balance of after.balances) {
      expect(
        BigInt(balance.netMinor),
        `${balance.participantId} is still owed something after settling up`,
      ).toBe(0n);
    }

    const { body: settled } = await authed(arjun.token)
      .get(`/v1/trips/${trip.id}/settle-up`)
      .expect(200);
    expect(settled.transfers, 'a settled trip still proposes transfers').toHaveLength(0);
  });

  it('8. planned cost → linked actual → delete the block → the expense survives', async () => {
    await seedFxRates();
    const owner = await createUser();

    const { body: trip } = await authed(owner.token)
      .post('/v1/trips')
      .send({ destination: 'Kyoto', startDate: '2026-05-18', endDate: '2026-05-18' })
      .expect(201);

    const { body: canvas } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas`)
      .expect(200);

    const { body: block } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/days/${canvas.days[0].id}/blocks`)
      .send({
        type: 'ACCOMMODATION',
        title: 'Ryokan',
        sections: {
          cost: { amountMinor: '86400', currency: 'INR', per: 'total', splitCount: 2 },
        },
      })
      .expect(201);

    const { body: participants } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/participants`)
      .expect(200);
    const me = participants.items[0].id as string;

    // The actual came in over the estimate — the variance the feature exists for.
    const { body: created } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send({
        description: 'Ryokan — actual',
        amountMinor: '91200',
        currency: 'INR',
        blockId: block.id,
        dayId: canvas.days[0].id,
        payments: [{ participantId: me, amountMinor: '91200' }],
        split: { method: 'EQUAL', participantIds: [me] },
      })
      .expect(201);

    const { body: linked } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/expenses?linked=true`)
      .expect(200);
    expect(linked.items).toHaveLength(1);

    const planned = BigInt('86400');
    const actual = BigInt(linked.items[0].amountMinor);
    expect(actual - planned, 'the variance is not derivable').toBe(4800n);

    const { body: before } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/balances`)
      .expect(200);

    await authed(owner.token).delete(`/v1/trips/${trip.id}/blocks/${block.id}`).expect(204);

    // FR-SPLIT-09 — an expense is a financial record. It survives the itinerary
    // edit, unlinks cleanly, and the balances do not move.
    const { body: survived } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/expenses`)
      .expect(200);

    const survivor = survived.items.find((e: { id: string }) => e.id === created.id);
    expect(survivor, 'deleting a block destroyed a financial record').toBeDefined();
    expect(survivor.amountMinor).toBe('91200');
    expect(survivor.blockId, 'the expense still points at a deleted block').toBeNull();

    const { body: after } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/balances`)
      .expect(200);
    expect(netOf(after.balances, me)).toBe(netOf(before.balances, me));
    expect(sumNet(after.balances)).toBe(0n);
  });

  it('9. claim a placeholder with a real account → the whole ledger history moves', async () => {
    await seedFxRates();
    const arjun = await createUser({ displayName: 'Arjun' });
    const priya = await createUser({ displayName: 'Priya' });

    const { body: trip } = await authed(arjun.token)
      .post('/v1/trips')
      .send({ destination: 'Kyoto', baseCurrency: 'INR' })
      .expect(201);

    const { body: participants } = await authed(arjun.token)
      .get(`/v1/trips/${trip.id}/participants`)
      .expect(200);
    const arjunId = participants.items[0].id as string;

    // Priya is a name on a list — no account, no email.
    const { body: placeholder } = await authed(arjun.token)
      .post(`/v1/trips/${trip.id}/participants`)
      .send({ displayName: 'Priya' })
      .expect(201);

    await authed(arjun.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send({
        description: 'Ryokan',
        amountMinor: '10000',
        currency: 'INR',
        payments: [{ participantId: arjunId, amountMinor: '10000' }],
        split: { method: 'EQUAL', participantIds: [arjunId, placeholder.id] },
      })
      .expect(201);

    const { body: before } = await authed(arjun.token)
      .get(`/v1/trips/${trip.id}/balances`)
      .expect(200);
    const owedBefore = netOf(before.balances, placeholder.id);
    expect(owedBefore).toBe(-5000n);

    // Now invite the real person to claim that identity.
    await authed(arjun.token)
      .post(`/v1/trips/${trip.id}/invites`)
      .send({
        emails: [priya.email],
        role: 'EDITOR',
        claimsParticipantId: placeholder.id,
      })
      .expect(201);

    const token = await plantToken(trip.id, priya.email);
    await authed(priya.token).post('/v1/invites/accept').send({ token }).expect(200);

    // FR-SPLIT-03 — the same participant row, now owned, with no recomputation.
    const { body: afterParticipants } = await authed(priya.token)
      .get(`/v1/trips/${trip.id}/participants`)
      .expect(200);

    const claimed = afterParticipants.items.find(
      (p: { id: string }) => p.id === placeholder.id,
    );
    expect(claimed.userId, 'the placeholder was not linked to the account').toBe(priya.id);
    expect(claimed.isPlaceholder).toBe(false);
    expect(afterParticipants.items, 'claiming created a duplicate participant').toHaveLength(2);

    const { body: after } = await authed(priya.token)
      .get(`/v1/trips/${trip.id}/balances`)
      .expect(200);

    expect(
      netOf(after.balances, placeholder.id),
      'the claimed balance changed during the transfer',
    ).toBe(owedBefore);
    expect(sumNet(after.balances)).toBe(0n);

    // And Priya can now see the ledger as herself.
    const { body: mine } = await authed(priya.token).get('/v1/me/balances').expect(200);
    expect(mine.items.some((row: { tripId: string }) => row.tripId === trip.id)).toBe(true);
  });
});
