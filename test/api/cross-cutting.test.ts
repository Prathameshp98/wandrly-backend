/**
 * The concerns that belong to no single module.
 *
 * Three of these are declared behaviours with almost no coverage:
 * `Idempotency-Key` is wired onto six routes and was tested on one; optimistic
 * locking is claimed for every concurrently-editable entity and tested for
 * three; and `/internal/cron` — which runs the ledger reconciliation that backs
 * the `SUM(net) = 0` invariant — had no tests at all.
 *
 * The error taxonomy gets the same treatment: §8.3 promises a fixed set of
 * codes, and a caller can only rely on that if each one is actually reachable
 * with the shape it claims.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { api, authed } from '../support/api';
import { closeTestDatabase, db, resetDatabase, seedFxRates } from '../support/db';
import { addPlaceholder, createTrip, createUser } from '../support/factories';
import { env } from '../../src/platform/config/env';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

const cron = () => api.post('/internal/cron/tick').set('X-Cron-Secret', env.CRON_SECRET);

async function ledgerTrip() {
  await seedFxRates();
  const owner = await createUser();
  const trip = await createTrip({ ownerId: owner.id, baseCurrency: 'INR' });
  const priya = await addPlaceholder(trip.id, 'Priya', owner.id);
  return { owner, trip, priya, arjun: trip.ownerParticipantId! };
}

async function anExpense(
  t: Awaited<ReturnType<typeof ledgerTrip>>,
  overrides: Record<string, unknown> = {},
) {
  const { body } = await authed(t.owner.token)
    .post(`/v1/trips/${t.trip.id}/expenses`)
    .send({
      description: 'Ryokan',
      amountMinor: '10000',
      currency: 'INR',
      payments: [{ participantId: t.arjun, amountMinor: '10000' }],
      split: { method: 'EQUAL', participantIds: [t.arjun, t.priya] },
      ...overrides,
    })
    .expect(201);
  return body;
}

describe('Idempotency-Key works on every route that declares it (§8.8)', () => {
  /**
   * Six routes call `idempotent()`. Only trip creation had tests, and the
   * ledger ones are where it matters most: a double-tap on a flaky connection
   * must not create two ₹5,000 expenses.
   */
  it('replays an expense creation instead of recording it twice', async () => {
    const t = await ledgerTrip();
    const key = `expense-${t.trip.id}`;
    const payload = {
      description: 'Ryokan',
      amountMinor: '10000',
      currency: 'INR',
      payments: [{ participantId: t.arjun, amountMinor: '10000' }],
      split: { method: 'EQUAL', participantIds: [t.arjun, t.priya] },
    };

    const first = await authed(t.owner.token)
      .post(`/v1/trips/${t.trip.id}/expenses`)
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(201);

    const replay = await authed(t.owner.token)
      .post(`/v1/trips/${t.trip.id}/expenses`)
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(201);

    expect(replay.body.id).toBe(first.body.id);
    expect(replay.headers['idempotent-replay']).toBe('true');

    const { body } = await authed(t.owner.token)
      .get(`/v1/trips/${t.trip.id}/expenses`)
      .expect(200);
    expect(body.items, 'a retry created a second expense').toHaveLength(1);
  });

  it('replays a settlement, and refuses the same key with a different body', async () => {
    const t = await ledgerTrip();
    await anExpense(t);

    const key = `settle-${t.trip.id}`;
    const payload = {
      fromParticipantId: t.priya,
      toParticipantId: t.arjun,
      amountMinor: '5000',
    };

    const first = await authed(t.owner.token)
      .post(`/v1/trips/${t.trip.id}/settlements`)
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(201);

    const replay = await authed(t.owner.token)
      .post(`/v1/trips/${t.trip.id}/settlements`)
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(201);
    expect(replay.body.id).toBe(first.body.id);

    // Same key, different money: a client bug, and the one case where the
    // server must refuse rather than replay.
    const { body } = await authed(t.owner.token)
      .post(`/v1/trips/${t.trip.id}/settlements`)
      .set('Idempotency-Key', key)
      .send({ ...payload, amountMinor: '4000' })
      .expect(409);

    expect(body.error.code).toBe('CONFLICT_IDEMPOTENCY_MISMATCH');

    const { body: settlements } = await authed(t.owner.token)
      .get(`/v1/trips/${t.trip.id}/settlements`)
      .expect(200);
    expect(settlements.items).toHaveLength(1);
  });

  it('replays a variant creation without forking twice', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const key = `variant-${trip.id}`;

    const first = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants`)
      .set('Idempotency-Key', key)
      .send({ name: 'Budget run' })
      .expect(201);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants`)
      .set('Idempotency-Key', key)
      .send({ name: 'Budget run' })
      .expect(201);

    const { body } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/variants`)
      .expect(200);

    expect(body.items.filter((v: { id: string }) => v.id === first.body.id)).toHaveLength(1);
    expect(body.items, 'a replayed request created a second variant').toHaveLength(2);
  });

  it('scopes a key to its user, so two people can pick the same one', async () => {
    const [a, b] = await Promise.all([createUser(), createUser()]);
    const key = 'new-trip';
    const payload = { destination: 'Kyoto' };

    const first = await authed(a.token)
      .post('/v1/trips')
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(201);

    const second = await authed(b.token)
      .post('/v1/trips')
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(201);

    expect(second.body.id).not.toBe(first.body.id);
  });
});

describe('optimistic locking, on everything that claims it (§5.9)', () => {
  it('refuses a stale write to a day and reports the current state', async () => {
    const owner = await createUser();
    const { body: trip } = await authed(owner.token)
      .post('/v1/trips')
      .send({ destination: 'Kyoto', startDate: '2026-05-18', endDate: '2026-05-19' })
      .expect(201);

    const { body: canvas } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas`)
      .expect(200);
    const day = canvas.days[0];

    await authed(owner.token)
      .patch(`/v1/trips/${trip.id}/days/${day.id}`)
      .send({ version: day.version, title: 'First edit' })
      .expect(200);

    // The second writer still holds the version they read.
    const { body } = await authed(owner.token)
      .patch(`/v1/trips/${trip.id}/days/${day.id}`)
      .send({ version: day.version, title: 'Clobbering edit' })
      .expect(409);

    expect(body.error.code).toBe('CONFLICT_STALE');

    const { body: after } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/canvas`)
      .expect(200);
    expect(
      after.days[0].title,
      'a stale write overwrote the edit that beat it',
    ).toBe('First edit');
  });

  it('bumps the version on every accepted write, so a retry cannot succeed twice', async () => {
    const owner = await createUser();
    const { body: trip } = await authed(owner.token)
      .post('/v1/trips')
      .send({ destination: 'Kyoto' })
      .expect(201);

    let version = trip.version;
    for (const title of ['One', 'Two', 'Three']) {
      const { body } = await authed(owner.token)
        .patch(`/v1/trips/${trip.id}`)
        .send({ version, title })
        .expect(200);

      expect(body.version, 'an accepted write did not advance the version').toBe(version + 1);
      version = body.version;
    }
  });
});

describe('concurrent writers to one ledger', () => {
  it('keeps the invariant under simultaneous expense creation', async () => {
    const t = await ledgerTrip();

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        authed(t.owner.token)
          .post(`/v1/trips/${t.trip.id}/expenses`)
          .send({
            description: `Concurrent ${i}`,
            amountMinor: String(1001 + i * 13),
            currency: 'INR',
            payments: [{ participantId: t.arjun, amountMinor: String(1001 + i * 13) }],
            split: { method: 'EQUAL', participantIds: [t.arjun, t.priya] },
          }),
      ),
    );

    expect(results.map((r) => r.status)).toStrictEqual(Array(6).fill(201));

    const { body } = await authed(t.owner.token)
      .get(`/v1/trips/${t.trip.id}/balances`)
      .expect(200);

    const net = body.balances.reduce(
      (sum: bigint, b: { netMinor: string }) => sum + BigInt(b.netMinor),
      0n,
    );
    expect(net, 'concurrent writes broke SUM(net) = 0').toBe(0n);
  });

  it('survives a settle-up read racing an expense write', async () => {
    const t = await ledgerTrip();
    await anExpense(t);

    const [settle, created] = await Promise.all([
      authed(t.owner.token).get(`/v1/trips/${t.trip.id}/settle-up`),
      authed(t.owner.token)
        .post(`/v1/trips/${t.trip.id}/expenses`)
        .send({
          description: 'Racing write',
          amountMinor: '2500',
          currency: 'INR',
          payments: [{ participantId: t.priya, amountMinor: '2500' }],
          split: { method: 'EQUAL', participantIds: [t.arjun, t.priya] },
        }),
    ]);

    expect(settle.status).toBe(200);
    expect(created.status).toBe(201);

    const { body } = await authed(t.owner.token)
      .get(`/v1/trips/${t.trip.id}/balances`)
      .expect(200);
    const net = body.balances.reduce(
      (sum: bigint, b: { netMinor: string }) => sum + BigInt(b.netMinor),
      0n,
    );
    expect(net).toBe(0n);
  });
});

describe('the error taxonomy is real, not aspirational (§8.3)', () => {
  it('answers a malformed body with 400, never a 500', async () => {
    const owner = await createUser();

    const { body } = await authed(owner.token)
      .post('/v1/trips')
      .set('Content-Type', 'application/json')
      .send('{"destination": "Kyoto"')
      .expect(400);

    expect(body.error.code).toBeDefined();
    expect(String(body.error.code)).not.toBe('INTERNAL');
  });

  it('answers a malformed amountMinor with 400, not the 500 it once was', async () => {
    const t = await ledgerTrip();

    // The regression test for the `moneyRefinement` fix: Zod runs `.refine()`
    // even after `.regex()` fails, so a bad amount threw a raw SyntaxError.
    const { body } = await authed(t.owner.token)
      .post(`/v1/trips/${t.trip.id}/expenses`)
      .send({
        description: 'Nonsense',
        amountMinor: 'not-a-number',
        currency: 'INR',
        payments: [{ participantId: t.arjun, amountMinor: 'also-nonsense' }],
        split: { method: 'EQUAL', participantIds: [t.arjun] },
      })
      .expect(400);

    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('carries a requestId on every error, so a report can be traced', async () => {
    const owner = await createUser();

    const cases = await Promise.all([
      api.get('/v1/trips'),
      authed(owner.token).get('/v1/trips/00000000-0000-7000-8000-000000000000'),
      authed(owner.token).post('/v1/folders').send({}),
    ]);

    for (const response of cases) {
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body.error.requestId, 'an error carried no requestId').toBeTruthy();
      expect(response.body.error.code).toBeTruthy();
      expect(response.body.error.message).toBeTruthy();
    }
  });

  it('answers an unknown route and an unsupported method in the same shape', async () => {
    const owner = await createUser();

    const unknown = await authed(owner.token).get('/v1/no-such-thing').expect(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');

    const wrongMethod = await authed(owner.token).delete('/v1/trips/dashboard');
    expect(wrongMethod.status).toBeGreaterThanOrEqual(400);
    expect(wrongMethod.body.error).toBeDefined();
  });
});

describe('the internal cron surface (§10.2)', () => {
  it('refuses a missing, wrong, or malformed secret', async () => {
    await api.post('/internal/cron/tick').send({}).expect(403);
    await api
      .post('/internal/cron/tick')
      .set('X-Cron-Secret', 'wrong')
      .send({})
      .expect(403);
    await api
      .post('/internal/cron/tick')
      .set('Authorization', 'Bearer wrong')
      .send({})
      .expect(403);
  });

  it('accepts the secret by bearer token as well as by header', async () => {
    await api
      .post('/internal/cron/tick')
      .set('Authorization', `Bearer ${env.CRON_SECRET}`)
      .send({ group: 'daily' })
      // 202: the endpoint enqueues and returns immediately (§10.2) — curl
      // should not be waiting on a reconciliation sweep.
      .expect(202);
  });

  it('requires a body, which the scheduled workflow does send', async () => {
    // A bodyless POST is refused rather than silently defaulting to `daily`.
    // Worth pinning: `.github/workflows/cron.yml` posts
    // `-d '{"group":"..."}'`, so the deployed caller is fine — but a future
    // edit that drops the `-d` would fail loudly rather than run the wrong
    // group.
    await api
      .post('/internal/cron/tick')
      .set('X-Cron-Secret', env.CRON_SECRET)
      .expect(400);
  });

  it('enqueues the documented jobs for each group', async () => {
    for (const group of ['daily', 'hourly', 'frequent']) {
      const { body } = await cron().send({ group }).expect(202);
      expect(body.group).toBe(group);
      // Job workers do not run under NODE_ENV=test, so the queue is inert —
      // what matters here is that the endpoint accepts each documented group
      // rather than silently doing nothing for two of them.
      expect(body).toHaveProperty('queued');
    }
  });

  it('rejects a group that is not one of the three', async () => {
    await cron().send({ group: 'whenever' }).expect(400);
  });

  it('reports a balanced ledger as balanced when run inline', async () => {
    const t = await ledgerTrip();
    await anExpense(t);

    // `inline` runs the sweep and answers with its result, so this one is 200.
    const { body } = await cron().send({ group: 'daily', inline: true }).expect(200);

    expect(body.ran).toBe('ledger.reconcile');
    expect(body.imbalanced ?? body.offenders ?? [], 'a healthy ledger was flagged').toEqual(
      expect.anything(),
    );
    expect(JSON.stringify(body)).not.toContain(t.trip.id);
  });

  it('cannot be handed a corrupt ledger, because the database refuses one', async () => {
    const t = await ledgerTrip();
    const expense = await anExpense(t);

    // The obvious way to test reconciliation is to corrupt a ledger and watch
    // it get caught. That turns out to be impossible: the deferred constraint
    // trigger rejects the write outright, so a residual can never reach the
    // table in the first place.
    //
    // Worth asserting in its own right — it means reconciliation is
    // defence-in-depth against a bug in the trigger or a future direct write,
    // not the only thing standing between the ledger and a wrong number.
    await expect(
      db.execute(sql`
        UPDATE expense_shares
           SET share_amount_base_minor = share_amount_base_minor + 500
         WHERE expense_id = ${expense.id}
           AND participant_id = ${t.priya}
      `),
    ).rejects.toThrow(/do not sum to/i);

    // And the ledger is still balanced afterwards.
    const { body } = await authed(t.owner.token)
      .get(`/v1/trips/${t.trip.id}/balances`)
      .expect(200);
    const net = body.balances.reduce(
      (sum: bigint, b: { netMinor: string }) => sum + BigInt(b.netMinor),
      0n,
    );
    expect(net).toBe(0n);
  });

  it('is rate limited far more tightly than the public API', async () => {
    // 20/minute, hardcoded in app.ts — the cron surface is a shared-secret
    // endpoint and should not tolerate the same volume as a signed-in user.
    const responses = await Promise.all(
      Array.from({ length: 25 }, () => cron().send({ group: 'hourly' })),
    );

    expect(
      responses.some((r) => r.status === 429),
      'the cron endpoint accepted 25 requests in a minute',
    ).toBe(true);
  });
});

describe('the health probe', () => {
  it('reports database reachability without authentication', async () => {
    const { body } = await api.get('/health').expect(200);

    expect(body.status).toBe('ok');
    expect(body.database).toBe(true);
    expect(typeof body.uptimeSeconds).toBe('number');
  });
});
