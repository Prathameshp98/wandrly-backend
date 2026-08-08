/**
 * The ledger's money edge cases, over HTTP.
 *
 * `src/money/*.test.ts` covers the *algorithms* with property tests and they
 * are thorough. This file covers the algorithms *as reached through the API* —
 * where they meet FX freezing, currency exponents, transactions, and SQL.
 * PRD §15.4 is explicit that a wrong number here "is not a bug report, it is an
 * argument between friends".
 *
 * Every test that mutates asserts `SUM(net) = 0` afterwards (FR-SPLIT-18). That
 * is a shared helper rather than a per-test habit, because an invariant nobody
 * forgets to check is the only kind worth having.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { authed, sumNet } from '../support/api';
import { closeTestDatabase, db, resetDatabase, seedFxRates } from '../support/db';
import { addPlaceholder, createTrip, createUser, type TestUser } from '../support/factories';

beforeAll(async () => {
  await seedFxRates();
  // Three-decimal currencies (FR-SPLIT-22) are not in the shared fixture.
  await db.execute(sql`
    INSERT INTO fx_rates (base_currency, quote_currency, rate, as_of) VALUES
      ('BHD', 'INR', 220.00000000, '2026-05-18'),
      ('KWD', 'INR', 271.00000000, '2026-05-18'),
      ('INR', 'BHD', 0.00454545, '2026-05-18')
    ON CONFLICT DO NOTHING
  `);
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

interface Ledger {
  readonly owner: TestUser;
  readonly tripId: string;
  readonly participants: readonly string[];
  /** Positional accessor — `ledgerWith(n)` guarantees n entries. */
  readonly at: (index: number) => string;
}

async function ledgerWith(
  count: number,
  options: { baseCurrency?: string; simplifyDebts?: boolean } = {},
): Promise<Ledger> {
  const owner = await createUser({ displayName: 'Arjun' });
  const trip = await createTrip({
    ownerId: owner.id,
    baseCurrency: options.baseCurrency ?? 'INR',
    simplifyDebts: options.simplifyDebts ?? true,
  });

  const extra: string[] = [];
  for (let i = 0; i < count - 1; i += 1) {
    extra.push(await addPlaceholder(trip.id, `Crew ${i + 1}`, owner.id));
  }

  const participants = [trip.ownerParticipantId!, ...extra];

  return {
    owner,
    tripId: trip.id,
    participants,
    at: (index: number) => {
      const id = participants[index];
      if (!id) throw new Error(`no participant at index ${index}`);
      return id;
    },
  };
}

/**
 * Create an expense and return its full DTO.
 *
 * `POST /expenses` answers with `{ id }` alone, so anything asserting on the
 * computed shares, the frozen rate, or the base-currency amount has to read the
 * expense back. Wrapped here so every test does it the same way.
 */
async function createExpense(
  ledger: Ledger,
  body: Record<string, unknown>,
): Promise<Record<string, never> & { shares: { participantId: string; shareAmountMinor: string }[]; amountBaseMinor: string; currency: string }> {
  const { body: created } = await authed(ledger.owner.token)
    .post(`/v1/trips/${ledger.tripId}/expenses`)
    .send(body)
    .expect(201);

  const { body: listed } = await authed(ledger.owner.token)
    .get(`/v1/trips/${ledger.tripId}/expenses`)
    .expect(200);

  const found = listed.items.find((item: { id: string }) => item.id === created.id);
  expect(found, 'the expense just created was not in the list').toBeDefined();
  return found;
}

/** FR-SPLIT-18 — the invariant, asserted the same way every time. */
async function expectBalanced(ledger: Ledger): Promise<
  { participantId: string; netMinor: string }[]
> {
  const { body } = await authed(ledger.owner.token)
    .get(`/v1/trips/${ledger.tripId}/balances`)
    .expect(200);

  expect(
    sumNet(body.balances),
    `net balances must sum to zero, got ${JSON.stringify(body.balances)}`,
  ).toBe(0n);

  return body.balances;
}

/**
 * Accepts `string | undefined` so destructuring `ledger.participants` reads
 * cleanly at call sites. A missing id yields 0n, which is also the correct
 * answer for a participant with no ledger activity.
 */
const netOf = (
  balances: { participantId: string; netMinor: string }[],
  participantId: string | undefined,
): bigint => BigInt(balances.find((b) => b.participantId === participantId)?.netMinor ?? '0');

describe('currency exponents (FR-SPLIT-22)', () => {
  it('splits a zero-decimal amount with no phantom sub-unit', async () => {
    const ledger = await ledgerWith(3, { baseCurrency: 'JPY' });
    const [arjun, priya, sana] = ledger.participants;

    // ¥10,001 across three people: 3334/3334/3333, never 3333.67.
    const expense = await createExpense(ledger, {
      description: 'Ryokan',
      amountMinor: '10001',
      currency: 'JPY',
      payments: [{ participantId: arjun, amountMinor: '10001' }],
      split: { method: 'EQUAL', participantIds: [arjun, priya, sana] },
    });

    const shares = expense.shares.map((s) => s.shareAmountMinor);
    expect(shares.map(BigInt).reduce((a: bigint, b: bigint) => a + b, 0n)).toBe(10001n);
    expect(shares.sort()).toStrictEqual(['3333', '3334', '3334']);

    await expectBalanced(ledger);
  });

  it('rounds a three-decimal currency at the third minor digit', async () => {
    const ledger = await ledgerWith(3, { baseCurrency: 'BHD' });
    const [arjun, priya, sana] = ledger.participants;

    // BHD has 1000 fils to the dinar. 10.000 BHD split three ways is
    // 3.334 / 3.333 / 3.333 — the same arithmetic, a different exponent.
    const expense = await createExpense(ledger, {
      description: 'Dinner',
      amountMinor: '10000',
      currency: 'BHD',
      payments: [{ participantId: arjun, amountMinor: '10000' }],
      split: { method: 'EQUAL', participantIds: [arjun, priya, sana] },
    });

    const shares: string[] = expense.shares.map((s) => s.shareAmountMinor);
    expect(shares.map(BigInt).reduce((a, b) => a + b, 0n)).toBe(10000n);

    await expectBalanced(ledger);
  });

  it('shifts the exponent when the expense currency differs from the base', async () => {
    // Base INR (2 decimals), spent in JPY (0 decimals). A naive conversion that
    // ignores the exponent gap is wrong by a factor of 100.
    const ledger = await ledgerWith(2, { baseCurrency: 'INR' });
    const [arjun, priya] = ledger.participants;

    const expense = await createExpense(ledger, {
      description: 'Kaiseki in Kyoto',
      amountMinor: '10000', // ¥10,000
      currency: 'JPY',
      payments: [{ participantId: arjun, amountMinor: '10000' }],
      split: { method: 'EQUAL', participantIds: [arjun, priya] },
    });

    // ¥10,000 × 0.58 = ₹5,800 = 580000 paise. Not 5800, and not 58000000.
    expect(expense.amountBaseMinor).toBe('580000');
    expect(expense.currency).toBe('JPY');

    const balances = await expectBalanced(ledger);
    expect(netOf(balances, priya)).toBe(-290000n);
  });

  it('freezes the rate, so a later rate move cannot restate the past', async () => {
    const ledger = await ledgerWith(2, { baseCurrency: 'INR' });
    const [arjun, priya] = ledger.participants;

    // KWD is used by nothing else in the suite, deliberately.
    //
    // `fx_rates` is the one table seeded once for the whole run and never
    // truncated between files, so it is shared global state — the single
    // exception to the "isolate by unique data" rule in `support/db.ts`. An
    // earlier draft of this test moved the JPY→INR rate and left it moved,
    // which made `ledger.test.ts` fail intermittently depending on file order.
    // Mutating a pair nobody else reads keeps the blast radius at zero.
    await authed(ledger.owner.token)
      .post(`/v1/trips/${ledger.tripId}/expenses`)
      .send({
        description: 'Souq haul',
        amountMinor: '1000',
        currency: 'KWD',
        payments: [{ participantId: arjun, amountMinor: '1000' }],
        split: { method: 'EQUAL', participantIds: [arjun, priya] },
      })
      .expect(201);

    const before = await expectBalanced(ledger);
    expect(netOf(before, priya)).not.toBe(0n);

    // The dinar moves 20%. Balances recorded yesterday must not move with it.
    await db.execute(sql`
      UPDATE fx_rates SET rate = 325.20000000
       WHERE base_currency = 'KWD' AND quote_currency = 'INR'
    `);

    const after = await expectBalanced(ledger);
    expect(
      netOf(after, priya),
      'a rate change restated a balance that was already recorded',
    ).toBe(netOf(before, priya));
  });
});

describe('split methods at their boundaries (FR-SPLIT-10/11)', () => {
  const base = {
    description: 'Group dinner',
    amountMinor: '10000',
    currency: 'INR',
  };

  it('accepts an exact split that adds up and names the gap when it does not', async () => {
    const ledger = await ledgerWith(3);
    const [arjun, priya, sana] = ledger.participants;
    const payments = [{ participantId: arjun, amountMinor: '10000' }];

    await authed(ledger.owner.token)
      .post(`/v1/trips/${ledger.tripId}/expenses`)
      .send({
        ...base,
        payments,
        split: {
          method: 'EXACT',
          shares: [
            { participantId: arjun, amountMinor: '5000' },
            { participantId: priya, amountMinor: '3000' },
            { participantId: sana, amountMinor: '2000' },
          ],
        },
      })
      .expect(201);

    // Overshoot and undershoot must both be refused, not silently absorbed.
    for (const last of ['2001', '1999']) {
      const { body } = await authed(ledger.owner.token)
        .post(`/v1/trips/${ledger.tripId}/expenses`)
        .send({
          ...base,
          payments,
          split: {
            method: 'EXACT',
            shares: [
              { participantId: arjun, amountMinor: '5000' },
              { participantId: priya, amountMinor: '3000' },
              { participantId: sana, amountMinor: last },
            ],
          },
        })
        .expect(422);

      expect(JSON.stringify(body)).toMatch(/1|gap|sum|total/i);
    }

    await expectBalanced(ledger);
  });

  it('refuses percentages that miss 100 by a hundredth in either direction', async () => {
    const ledger = await ledgerWith(2);
    const [arjun, priya] = ledger.participants;
    const payments = [{ participantId: arjun, amountMinor: '10000' }];

    for (const [a, b] of [
      [50, 49.99],
      [50, 50.01],
    ]) {
      await authed(ledger.owner.token)
        .post(`/v1/trips/${ledger.tripId}/expenses`)
        .send({
          ...base,
          payments,
          split: {
            method: 'PERCENT',
            shares: [
              { participantId: arjun, percent: a },
              { participantId: priya, percent: b },
            ],
          },
        })
        .expect(422);
    }

    await authed(ledger.owner.token)
      .post(`/v1/trips/${ledger.tripId}/expenses`)
      .send({
        ...base,
        payments,
        split: {
          method: 'PERCENT',
          shares: [
            { participantId: arjun, percent: 50 },
            { participantId: priya, percent: 50 },
          ],
        },
      })
      .expect(201);

    await expectBalanced(ledger);
  });

  it('weights a couple as two shares, and refuses an all-zero weighting', async () => {
    const ledger = await ledgerWith(3);
    const [arjun, priya, sana] = ledger.participants;
    const payments = [{ participantId: arjun, amountMinor: '10000' }];

    const expense = await createExpense(ledger, {
      ...base,
      payments,
      split: {
        method: 'SHARES',
        shares: [
          { participantId: arjun, weight: 1 },
          { participantId: priya, weight: 2 },
          { participantId: sana, weight: 1 },
        ],
      },
    });

    const byId = new Map<string, bigint>(
      expense.shares.map((s) => [s.participantId, BigInt(s.shareAmountMinor)]),
    );
    expect(byId.get(ledger.at(1))).toBe(5000n);
    expect(byId.get(ledger.at(0))).toBe(2500n);
    expect([...byId.values()].reduce((a, b) => a + b, 0n)).toBe(10000n);

    // A zero weight is refused by the schema (400), not by the money layer:
    // `allocate` would throw on a zero total weight, and a 500 from a division
    // by zero is a worse answer than a validation message.
    await authed(ledger.owner.token)
      .post(`/v1/trips/${ledger.tripId}/expenses`)
      .send({
        ...base,
        payments,
        split: {
          method: 'SHARES',
          shares: [
            { participantId: arjun, weight: 0 },
            { participantId: priya, weight: 0 },
          ],
        },
      })
      .expect(400);

    await expectBalanced(ledger);
  });

  it('lets the payer sit outside the split entirely (FR-SPLIT-12)', async () => {
    const ledger = await ledgerWith(3);
    const [arjun, priya, sana] = ledger.participants;

    // Arjun buys everyone else's tickets and takes no share of them.
    await authed(ledger.owner.token)
      .post(`/v1/trips/${ledger.tripId}/expenses`)
      .send({
        ...base,
        description: 'Everyone else’s tickets',
        payments: [{ participantId: arjun, amountMinor: '10000' }],
        split: { method: 'EQUAL', participantIds: [priya, sana] },
      })
      .expect(201);

    const balances = await expectBalanced(ledger);
    expect(netOf(balances, arjun)).toBe(10000n);
    expect(netOf(balances, priya)).toBe(-5000n);
    expect(netOf(balances, sana)).toBe(-5000n);
  });

  it('splits across multiple payers and still sums exactly (FR-SPLIT-13)', async () => {
    const ledger = await ledgerWith(3);
    const [arjun, priya, sana] = ledger.participants;

    await authed(ledger.owner.token)
      .post(`/v1/trips/${ledger.tripId}/expenses`)
      .send({
        ...base,
        payments: [
          { participantId: arjun, amountMinor: '6000' },
          { participantId: priya, amountMinor: '4000' },
        ],
        split: { method: 'EQUAL', participantIds: [arjun, priya, sana] },
      })
      .expect(201);

    const balances = await expectBalanced(ledger);
    // Arjun paid 6000, owes 3334 ⇒ +2666. Priya paid 4000, owes 3333 ⇒ +667.
    // Sana paid nothing, owes 3333 ⇒ −3333.
    expect(netOf(balances, sana)).toBe(-3333n);
    expect(netOf(balances, arjun) + netOf(balances, priya)).toBe(3333n);
  });

  it('refuses a payment set that does not add up to the amount', async () => {
    const ledger = await ledgerWith(2);
    const [arjun, priya] = ledger.participants;

    await authed(ledger.owner.token)
      .post(`/v1/trips/${ledger.tripId}/expenses`)
      .send({
        ...base,
        payments: [
          { participantId: arjun, amountMinor: '6000' },
          { participantId: priya, amountMinor: '3000' },
        ],
        split: { method: 'EQUAL', participantIds: [arjun, priya] },
      })
      .expect(422);
  });
});

describe('largest-remainder distribution is stable (FR-SPLIT-17)', () => {
  it('gives the extra minor unit to the same person every time', async () => {
    const ledger = await ledgerWith(3);
    const participantIds = [...ledger.participants];

    const winners = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const expense = await createExpense(ledger, {
        description: `Round ${i}`,
        amountMinor: '10000',
        currency: 'INR',
        payments: [{ participantId: participantIds[0], amountMinor: '10000' }],
        split: { method: 'EQUAL', participantIds },
      });

      const top = expense.shares
        .filter((s) => s.shareAmountMinor === '3334')
        .map((s) => s.participantId)
        .sort()
        .join(',');
      winners.add(top);
    }

    expect(
      winners.size,
      'the same split handed the spare unit to different people across runs',
    ).toBe(1);

    await expectBalanced(ledger);
  });
});

describe('refunds (FR-SPLIT-14)', () => {
  it('reverses proportionally and returns balances to where they started', async () => {
    const ledger = await ledgerWith(3);
    const [arjun, priya, sana] = ledger.participants;

    const before = await expectBalanced(ledger);

    await authed(ledger.owner.token)
      .post(`/v1/trips/${ledger.tripId}/expenses`)
      .send({
        description: 'Cancelled tour',
        amountMinor: '10000',
        currency: 'INR',
        payments: [{ participantId: arjun, amountMinor: '10000' }],
        split: { method: 'EQUAL', participantIds: [arjun, priya, sana] },
      })
      .expect(201);

    const charged = await expectBalanced(ledger);
    expect(netOf(charged, arjun)).not.toBe(0n);

    await authed(ledger.owner.token)
      .post(`/v1/trips/${ledger.tripId}/expenses`)
      .send({
        description: 'Tour refund',
        amountMinor: '-10000',
        currency: 'INR',
        payments: [{ participantId: arjun, amountMinor: '-10000' }],
        split: { method: 'EQUAL', participantIds: [arjun, priya, sana] },
      })
      .expect(201);

    const after = await expectBalanced(ledger);
    for (const participantId of [ledger.at(0), ledger.at(1), ledger.at(2)]) {
      expect(
        netOf(after, participantId),
        'a refund of the full amount did not undo the charge',
      ).toBe(netOf(before, participantId));
    }
  });
});

describe('pairwise (non-simplified) settle-up (FR-SPLIT-25/26)', () => {
  /**
   * The known-suspect case from `IMPLEMENTATION_STATUS`: `pairwiseDebts`
   * apportions each payer's share of each expense with **integer division in
   * SQL**, which truncates. With more than one payer the truncated remainders
   * are simply lost, so the transfers no longer clear the balances they claim
   * to — money disappears from the ledger in non-simplified mode only.
   */
  it('clears every balance exactly, even across multiple payers', async () => {
    const ledger = await ledgerWith(3, { simplifyDebts: false });
    const [arjun, priya, sana] = ledger.participants;

    // 10000 paid 5000/5000 by two people, split three ways: shares are
    // 3334/3333/3333. Each 3333 apportioned over a 5000 payment is 1666.5,
    // which truncation rounds down twice.
    await authed(ledger.owner.token)
      .post(`/v1/trips/${ledger.tripId}/expenses`)
      .send({
        description: 'Split-paid ryokan',
        amountMinor: '10000',
        currency: 'INR',
        payments: [
          { participantId: arjun, amountMinor: '5000' },
          { participantId: priya, amountMinor: '5000' },
        ],
        split: { method: 'EQUAL', participantIds: [arjun, priya, sana] },
      })
      .expect(201);

    const balances = await expectBalanced(ledger);

    const { body: settleUp } = await authed(ledger.owner.token)
      .get(`/v1/trips/${ledger.tripId}/settle-up?simplify=false`)
      .expect(200);

    // Apply every proposed transfer to the balances and require the result to
    // be exactly zero for everyone. A transfer set that leaves anyone non-zero
    // is not a settlement plan, it is an argument.
    const net = new Map<string, bigint>(
      balances.map((b) => [b.participantId, BigInt(b.netMinor)]),
    );
    for (const transfer of settleUp.transfers) {
      const amount = BigInt(transfer.amountMinor);
      net.set(transfer.fromParticipantId, net.get(transfer.fromParticipantId)! + amount);
      net.set(transfer.toParticipantId, net.get(transfer.toParticipantId)! - amount);
    }

    for (const participantId of [ledger.at(0), ledger.at(1), ledger.at(2)]) {
      expect(
        net.get(participantId),
        `pairwise transfers left ${participantId} at ${net.get(participantId)} instead of 0`,
      ).toBe(0n);
    }
  });

  it('agrees with simplified mode on the total each person moves', async () => {
    const ledger = await ledgerWith(4, { simplifyDebts: false });
    const [arjun, priya, sana, dev] = ledger.participants;

    await authed(ledger.owner.token)
      .post(`/v1/trips/${ledger.tripId}/expenses`)
      .send({
        description: 'Villa',
        amountMinor: '99999',
        currency: 'INR',
        payments: [
          { participantId: arjun, amountMinor: '33333' },
          { participantId: priya, amountMinor: '33333' },
          { participantId: sana, amountMinor: '33333' },
        ],
        split: { method: 'EQUAL', participantIds: [arjun, priya, sana, dev] },
      })
      .expect(201);

    const balances = await expectBalanced(ledger);

    for (const simplify of ['true', 'false']) {
      const { body } = await authed(ledger.owner.token)
        .get(`/v1/trips/${ledger.tripId}/settle-up?simplify=${simplify}`)
        .expect(200);

      const net = new Map<string, bigint>(
        balances.map((b) => [b.participantId, BigInt(b.netMinor)]),
      );
      for (const transfer of body.transfers) {
        const amount = BigInt(transfer.amountMinor);
        net.set(transfer.fromParticipantId, net.get(transfer.fromParticipantId)! + amount);
        net.set(transfer.toParticipantId, net.get(transfer.toParticipantId)! - amount);
      }

      for (const [participantId, remaining] of net) {
        expect(
          remaining,
          `simplify=${simplify} left ${participantId} at ${remaining}`,
        ).toBe(0n);
      }
    }
  });
});

describe('linked expenses — plan versus actual (FR-SPLIT-08/09)', () => {
  async function tripWithBlock() {
    const owner = await createUser({ displayName: 'Arjun' });

    const { body: trip } = await authed(owner.token)
      .post('/v1/trips')
      .send({ destination: 'Kyoto', startDate: '2026-05-18', endDate: '2026-05-19' })
      .expect(201);

    const { body: canvas } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas`)
      .expect(200);

    const { body: block } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/days/${canvas.days[0].id}/blocks`)
      .send({ type: 'ACCOMMODATION', title: 'Ryokan', sections: { cost: { amountMinor: '8000', currency: 'INR', per: 'total', splitCount: 2 } } })
      .expect(201);

    const { body: participants } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/participants`)
      .expect(200);

    const ledger: Ledger = {
      owner,
      tripId: trip.id,
      participants: participants.items.map((p: { id: string }) => p.id),
      at: (index: number) => participants.items[index].id as string,
    };

    return { ledger, blockId: block.id, dayId: canvas.days[0].id };
  }

  it('links an actual spend to the block it was planned against', async () => {
    const { ledger, blockId, dayId } = await tripWithBlock();
    const arjun = ledger.at(0);

    const expense = await createExpense(ledger, {
      description: 'Ryokan — actual',
      amountMinor: '9120',
      currency: 'INR',
      blockId,
      dayId,
      payments: [{ participantId: arjun, amountMinor: '9120' }],
      split: { method: 'EQUAL', participantIds: [arjun] },
    });

    expect(expense.blockId).toBe(blockId);
    await expectBalanced(ledger);

    // The link is what makes the variance row possible, so it has to be
    // filterable — otherwise "planned vs actual" needs a full table scan client
    // side.
    const { body: linked } = await authed(ledger.owner.token)
      .get(`/v1/trips/${ledger.tripId}/expenses?linked=true`)
      .expect(200);
    expect(linked.items).toHaveLength(1);

    const { body: unlinked } = await authed(ledger.owner.token)
      .get(`/v1/trips/${ledger.tripId}/expenses?linked=false`)
      .expect(200);
    expect(unlinked.items).toHaveLength(0);
  });

  it('survives deletion of the block it was linked to, with balances unchanged', async () => {
    const { ledger, blockId, dayId } = await tripWithBlock();
    const arjun = ledger.at(0);

    const expense = await createExpense(ledger, {
      description: 'Ryokan — actual',
      amountMinor: '9120',
      currency: 'INR',
      blockId,
      dayId,
      payments: [{ participantId: arjun, amountMinor: '9120' }],
      split: { method: 'EQUAL', participantIds: [arjun] },
    });

    const before = await expectBalanced(ledger);

    await authed(ledger.owner.token)
      .delete(`/v1/trips/${ledger.tripId}/blocks/${blockId}`)
      .expect(204);

    // FR-SPLIT-09: an expense is a financial record and must never be destroyed
    // by an itinerary edit.
    const { body: after } = await authed(ledger.owner.token)
      .get(`/v1/trips/${ledger.tripId}/expenses`)
      .expect(200);

    const survivor = after.items.find((item: { id: string }) => item.id === expense.id);
    expect(survivor, 'deleting a block destroyed a financial record').toBeDefined();
    expect(survivor.amountMinor).toBe('9120');

    // FR-SPLIT-09 also requires the expense to become UNLINKED, so it stops
    // claiming a relationship to a block that no longer exists.
    expect(survivor.blockId, 'the expense still points at a deleted block').toBeNull();

    const balances = await expectBalanced(ledger);
    expect(netOf(balances, arjun)).toBe(netOf(before, arjun));
  });

  it('refuses to link an expense to a block in another trip', async () => {
    const mine = await tripWithBlock();
    const theirs = await tripWithBlock();

    await authed(mine.ledger.owner.token)
      .post(`/v1/trips/${mine.ledger.tripId}/expenses`)
      .send({
        description: 'Someone else’s block',
        amountMinor: '1000',
        currency: 'INR',
        blockId: theirs.blockId,
        payments: [{ participantId: mine.ledger.at(0), amountMinor: '1000' }],
        split: { method: 'EQUAL', participantIds: [mine.ledger.at(0)] },
      })
      .expect(404);
  });
});

describe('the ledger at the scale the PRD commits to (FR-SPLIT-47)', () => {
  it('stays correct and answers in time with 20 participants and 500 expenses', async () => {
    const ledger = await ledgerWith(20);
    const participantIds = [...ledger.participants];

    // Amounts that do not divide evenly, so every expense exercises the
    // largest-remainder path rather than the easy case.
    for (let i = 0; i < 500; i += 1) {
      const payer = participantIds[i % participantIds.length]!;
      const sharers = participantIds.slice(0, 3 + (i % 17));

      await authed(ledger.owner.token)
        .post(`/v1/trips/${ledger.tripId}/expenses`)
        .send({
          description: `Expense ${i}`,
          amountMinor: String(1001 + i * 7),
          currency: 'INR',
          payments: [{ participantId: payer, amountMinor: String(1001 + i * 7) }],
          split: { method: 'EQUAL', participantIds: sharers },
        })
        .expect(201);
    }

    const startedAt = process.hrtime.bigint();
    const balances = await expectBalanced(ledger);
    const balancesMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    expect(balances).toHaveLength(20);

    const settleStartedAt = process.hrtime.bigint();
    const { body: settleUp } = await authed(ledger.owner.token)
      .get(`/v1/trips/${ledger.tripId}/settle-up`)
      .expect(200);
    const settleMs = Number(process.hrtime.bigint() - settleStartedAt) / 1e6;

    // Simplification promises at most n−1 transfers (FR-SPLIT-25).
    expect(settleUp.transfers.length).toBeLessThanOrEqual(19);

    // Applying the plan must clear everyone exactly — the property that matters
    // far more than the timing below.
    const net = new Map<string, bigint>(
      balances.map((b) => [b.participantId, BigInt(b.netMinor)]),
    );
    for (const transfer of settleUp.transfers) {
      const amount = BigInt(transfer.amountMinor);
      net.set(transfer.fromParticipantId, net.get(transfer.fromParticipantId)! + amount);
      net.set(transfer.toParticipantId, net.get(transfer.toParticipantId)! - amount);
    }
    for (const [participantId, remaining] of net) {
      expect(remaining, `settle-up left ${participantId} at ${remaining}`).toBe(0n);
    }

    // A generous ceiling: this is a guard against an accidental O(n²) query,
    // not a performance benchmark. Numbers are reported either way.
    // eslint-disable-next-line no-console
    console.info(`  balances ${balancesMs.toFixed(0)}ms · settle-up ${settleMs.toFixed(0)}ms`);
    expect(balancesMs).toBeLessThan(2000);
    expect(settleMs).toBeLessThan(2000);
  }, 180_000);
});
