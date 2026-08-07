/**
 * Ledger API tests — HTTP → Express → real Postgres.
 *
 * DEVELOPMENT_FLOW.md §1 layer 2. No frontend involved.
 *
 * These back-fill coverage for the ledger, which shipped with unit tests on its
 * pure logic but nothing exercising the wiring: routes, authorization,
 * serialisation, transactions, and the deferred database triggers.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { authed, sumNet } from '../support/api';
import { closeTestDatabase, resetDatabase, seedFxRates } from '../support/db';
import {
  addMember,
  addPlaceholder,
  createTrip,
  createTripWithCrew,
  createUser,
} from '../support/factories';

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  await seedFxRates();
});

afterAll(async () => {
  // Each file owns its pool under `isolate: true`, so each closes its own.
  await closeTestDatabase();
});

/** Equal-split expense helper — the shape most tests need. */
const equalExpense = (
  payerId: string,
  participantIds: string[],
  amountMinor: string,
  currency = 'INR',
) => ({
  description: 'Dinner',
  amountMinor,
  currency,
  payments: [{ participantId: payerId, amountMinor }],
  split: { method: 'EQUAL' as const, participantIds },
});

describe('POST /v1/trips/:tripId/expenses', () => {
  it('records an expense and keeps the ledger balanced', async () => {
    const { owner, trip, participantIds } = await createTripWithCrew(2);

    const created = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send(equalExpense(participantIds[0]!, participantIds, '90000'))
      .expect(201);

    expect(created.body.id).toBeDefined();

    const { body } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/balances`)
      .expect(200);

    expect(sumNet(body.balances)).toBe(0n);
    expect(body.totalSpentMinor).toBe('90000');
    expect(body.isFullySettled).toBe(false);

    // Payer is owed two thirds; each other participant owes one third.
    const payer = body.balances.find(
      (b: { participantId: string }) => b.participantId === participantIds[0],
    );
    expect(payer.netMinor).toBe('60000');
  });

  it('freezes the FX rate and stores both currency views', async () => {
    const { owner, trip, participantIds } = await createTripWithCrew(2);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send(equalExpense(participantIds[0]!, participantIds, '10000', 'JPY'))
      .expect(201);

    const { body } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/expenses`)
      .expect(200);

    const expense = body.items[0];
    expect(expense.currency).toBe('JPY');
    expect(expense.amountMinor).toBe('10000');
    // ¥10,000 at 0.58 → ₹5,800 → 580000 paise. The exponent shift matters:
    // getting it wrong understates the expense by 100×.
    expect(expense.amountBaseMinor).toBe('580000');
    expect(expense.fxRateSource).toBe('AUTO');

    // Both currency views sum exactly to their own total.
    const native = expense.shares.reduce(
      (s: bigint, x: { shareAmountMinor: string }) => s + BigInt(x.shareAmountMinor),
      0n,
    );
    const base = expense.shares.reduce(
      (s: bigint, x: { shareAmountBaseMinor: string }) => s + BigInt(x.shareAmountBaseMinor),
      0n,
    );
    expect(native).toBe(10_000n);
    expect(base).toBe(580_000n);
  });

  it('rejects an EXACT split that does not add up, naming the gap', async () => {
    const { owner, trip, participantIds } = await createTripWithCrew(1);

    const { body } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send({
        description: 'Bad split',
        amountMinor: '10000',
        currency: 'INR',
        payments: [{ participantId: participantIds[0], amountMinor: '10000' }],
        split: {
          method: 'EXACT',
          shares: [
            { participantId: participantIds[0], amountMinor: '4000' },
            { participantId: participantIds[1], amountMinor: '4000' },
          ],
        },
      })
      .expect(422);

    expect(body.error.code).toBe('LEDGER_SHARES_MISMATCH');
    expect(body.error.details.differenceMinor).toBe('2000');
  });

  it('rejects percentages that do not total 100', async () => {
    const { owner, trip, participantIds } = await createTripWithCrew(1);

    const { body } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send({
        description: 'Bad percent',
        amountMinor: '10000',
        currency: 'INR',
        payments: [{ participantId: participantIds[0], amountMinor: '10000' }],
        split: {
          method: 'PERCENT',
          shares: [
            { participantId: participantIds[0], percent: 50 },
            { participantId: participantIds[1], percent: 30 },
          ],
        },
      })
      .expect(422);

    expect(body.error.message).toMatch(/100%/);
  });

  it('rejects a participant from another trip', async () => {
    const { owner, trip, participantIds } = await createTripWithCrew(1);
    const other = await createTripWithCrew(1);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send(equalExpense(participantIds[0]!, [other.participantIds[0]!], '10000'))
      .expect(422);
  });

  it('rejects a malformed body at the validation boundary', async () => {
    const { owner, trip } = await createTripWithCrew(1);

    const { body } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send({ description: '', amountMinor: 'not-a-number' })
      .expect(400);

    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details.issues.length).toBeGreaterThan(0);
  });

  it('handles a refund as a negative expense', async () => {
    const { owner, trip, participantIds } = await createTripWithCrew(2);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send(equalExpense(participantIds[0]!, participantIds, '90000'))
      .expect(201);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send({
        ...equalExpense(participantIds[0]!, participantIds, '-30000'),
        description: 'Partial refund',
      })
      .expect(201);

    const { body } = await authed(owner.token).get(`/v1/trips/${trip.id}/balances`);
    expect(sumNet(body.balances)).toBe(0n);
    expect(body.totalSpentMinor).toBe('60000');
  });
});

describe('balances and settle-up', () => {
  it('clears every balance with at most n−1 transfers', async () => {
    const { owner, trip, participantIds } = await createTripWithCrew(3);

    // Two expenses with different payers, so the debt graph is non-trivial.
    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send(equalExpense(participantIds[0]!, participantIds, '100000'))
      .expect(201);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send(equalExpense(participantIds[1]!, participantIds, '40000'))
      .expect(201);

    const { body } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/settle-up`)
      .expect(200);

    expect(body.simplified).toBe(true);
    expect(body.transfers.length).toBeLessThanOrEqual(participantIds.length - 1);

    // Applying every suggested transfer must clear the ledger.
    for (const transfer of body.transfers) {
      await authed(owner.token)
        .post(`/v1/trips/${trip.id}/settlements`)
        .send({
          fromParticipantId: transfer.fromParticipantId,
          toParticipantId: transfer.toParticipantId,
          amountMinor: transfer.amountMinor,
          method: 'UPI',
        })
        .expect(201);
    }

    const { body: after } = await authed(owner.token).get(`/v1/trips/${trip.id}/balances`);
    expect(sumNet(after.balances)).toBe(0n);
    expect(after.isFullySettled).toBe(true);
    for (const balance of after.balances) expect(balance.netMinor).toBe('0');
  });

  it('reports a settled trip as settled from the start', async () => {
    const { owner, trip } = await createTripWithCrew(2);
    const { body } = await authed(owner.token).get(`/v1/trips/${trip.id}/balances`);
    expect(body.isFullySettled).toBe(true);
    expect(body.transfers).toBeUndefined();
  });

  it('honours the non-simplified pairwise mode', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id, simplifyDebts: false });
    const other = await addPlaceholder(trip.id, 'Priya', owner.id);
    const ids = [trip.ownerParticipantId!, other];

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send(equalExpense(ids[0]!, ids, '10000'))
      .expect(201);

    const { body } = await authed(owner.token).get(`/v1/trips/${trip.id}/settle-up`);
    expect(body.simplified).toBe(false);
    expect(body.transfers.length).toBeGreaterThan(0);
  });

  it('records, confirms and voids a settlement', async () => {
    const { owner, trip, participantIds } = await createTripWithCrew(1);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send(equalExpense(participantIds[0]!, participantIds, '10000'))
      .expect(201);

    const { body: created } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/settlements`)
      .send({
        fromParticipantId: participantIds[1],
        toParticipantId: participantIds[0],
        amountMinor: '5000',
        method: 'CASH',
      })
      .expect(201);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/settlements/${created.id}/confirm`)
      .expect(200);

    const { body: voided } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/settlements/${created.id}/void`)
      .send({ reason: 'Recorded twice by mistake' })
      .expect(200);

    expect(voided.voidedAt).toBeTruthy();

    // Voiding restores the balance, and history is retained rather than deleted.
    const { body: history } = await authed(owner.token).get(
      `/v1/trips/${trip.id}/settlements`,
    );
    expect(history.items).toHaveLength(1);
    expect(history.items[0].voidReason).toBe('Recorded twice by mistake');
  });
});

describe('participants', () => {
  it('adds a placeholder with no account', async () => {
    const { owner, trip } = await createTripWithCrew(0);

    const { body } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/participants`)
      .send({ displayName: 'Mom' })
      .expect(201);

    expect(body.isPlaceholder).toBe(true);
    expect(body.userId).toBeNull();
    expect(body.hasPayoutDetails).toBe(false);
  });

  it('never returns payout identifiers, only a boolean', async () => {
    const { owner, trip, participantIds } = await createTripWithCrew(1);

    await authed(owner.token)
      .patch(`/v1/trips/${trip.id}/participants/${participantIds[0]}`)
      .send({ payoutUpiId: 'arjun@okhdfc' })
      .expect(200);

    const { body } = await authed(owner.token).get(`/v1/trips/${trip.id}/participants`);
    const participant = body.items.find(
      (p: { id: string }) => p.id === participantIds[0],
    );

    expect(participant.hasPayoutDetails).toBe(true);
    expect(JSON.stringify(body)).not.toContain('arjun@okhdfc');
  });

  it('blocks removing a participant who owes money', async () => {
    const { owner, trip, participantIds } = await createTripWithCrew(1);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send(equalExpense(participantIds[0]!, participantIds, '10000'))
      .expect(201);

    const { body } = await authed(owner.token)
      .delete(`/v1/trips/${trip.id}/participants/${participantIds[1]}`)
      .expect(422);

    expect(body.error.code).toBe('LEDGER_PARTICIPANT_HAS_HISTORY');
  });

  it('allows removal when their share is reassigned', async () => {
    const { owner, trip, participantIds } = await createTripWithCrew(2);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send(equalExpense(participantIds[0]!, participantIds, '90000'))
      .expect(201);

    await authed(owner.token)
      .delete(
        `/v1/trips/${trip.id}/participants/${participantIds[2]}` +
          `?reassignToParticipantId=${participantIds[1]}`,
      )
      .expect(204);

    // The ledger must still balance after a reassignment.
    const { body } = await authed(owner.token).get(`/v1/trips/${trip.id}/balances`);
    expect(sumNet(body.balances)).toBe(0n);
  });
});

describe('authorization', () => {
  it('rejects an unauthenticated request', async () => {
    const { trip } = await createTripWithCrew(1);
    const { body } = await authed('not-a-real-token')
      .get(`/v1/trips/${trip.id}/balances`)
      .expect(401);
    expect(body.error.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('returns 404 — not 403 — for a trip you are not a member of', async () => {
    // §8.4: the API must never be an existence oracle.
    const { trip } = await createTripWithCrew(1);
    const stranger = await createUser();

    const { body } = await authed(stranger.token)
      .get(`/v1/trips/${trip.id}/balances`)
      .expect(404);

    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('forbids a CONTRIBUTOR from managing participants', async () => {
    const { trip } = await createTripWithCrew(1);
    const contributor = await addMember(trip.id, 'CONTRIBUTOR');

    const { body } = await authed(contributor.token)
      .post(`/v1/trips/${trip.id}/participants`)
      .send({ displayName: 'Nope' })
      .expect(403);

    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('forbids a VIEWER from creating an expense', async () => {
    const { trip } = await createTripWithCrew(1);
    const viewer = await addMember(trip.id, 'VIEWER');

    await authed(viewer.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send(equalExpense(trip.ownerParticipantId!, [trip.ownerParticipantId!], '1000'))
      .expect(403);
  });

  it('shows a VIEWER only the expenses they are part of', async () => {
    // FR-NFR-SEC-10 — scoped in SQL, not hidden client-side.
    const { owner, trip, participantIds } = await createTripWithCrew(1);
    const viewer = await addMember(trip.id, 'VIEWER');

    // An expense the viewer is NOT part of.
    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send(equalExpense(participantIds[0]!, participantIds, '10000'))
      .expect(201);

    // An expense the viewer IS part of.
    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send(
        equalExpense(participantIds[0]!, [participantIds[0]!, viewer.participantId!], '20000'),
      )
      .expect(201);

    const { body } = await authed(viewer.token)
      .get(`/v1/trips/${trip.id}/expenses`)
      .expect(200);

    expect(body.items).toHaveLength(1);
    expect(body.items[0].amountMinor).toBe('20000');
  });

  it('blocks mutation of an archived trip regardless of role', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id, isArchived: true });

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/participants`)
      .send({ displayName: 'Nope' })
      .expect(403);

    // …but reading still works.
    await authed(owner.token).get(`/v1/trips/${trip.id}/participants`).expect(200);
  });
});

describe('expense lifecycle', () => {
  it('soft-deletes and restores, keeping balances correct throughout', async () => {
    const { owner, trip, participantIds } = await createTripWithCrew(1);

    const { body: created } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send(equalExpense(participantIds[0]!, participantIds, '10000'))
      .expect(201);

    await authed(owner.token)
      .delete(`/v1/trips/${trip.id}/expenses/${created.id}`)
      .expect(204);

    const { body: afterDelete } = await authed(owner.token).get(
      `/v1/trips/${trip.id}/balances`,
    );
    expect(afterDelete.totalSpentMinor).toBe('0');
    expect(sumNet(afterDelete.balances)).toBe(0n);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses/${created.id}/restore`)
      .expect(204);

    const { body: afterRestore } = await authed(owner.token).get(
      `/v1/trips/${trip.id}/balances`,
    );
    expect(afterRestore.totalSpentMinor).toBe('10000');
    expect(sumNet(afterRestore.balances)).toBe(0n);
  });
});

describe('GET /v1/me/balances', () => {
  it('summarises non-zero balances across trips', async () => {
    const { owner, trip, participantIds } = await createTripWithCrew(1);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send(equalExpense(participantIds[0]!, participantIds, '10000'))
      .expect(201);

    const { body } = await authed(owner.token).get('/v1/me/balances').expect(200);

    expect(body.items).toHaveLength(1);
    expect(body.items[0].tripId).toBe(trip.id);
    expect(BigInt(body.items[0].netMinor)).toBeGreaterThan(0n);
  });

  it('omits trips that are square', async () => {
    const { owner } = await createTripWithCrew(1);
    const { body } = await authed(owner.token).get('/v1/me/balances').expect(200);
    expect(body.items).toHaveLength(0);
  });
});
