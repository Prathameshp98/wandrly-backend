/**
 * Ledger jobs.
 *
 * The reconciliation job is the single most important background task in the
 * system: it is the third leg of the triple guard on `SUM(net) = 0`
 * (FR-SPLIT-18), and the one alert that should wake you up (§16).
 */

import type PgBoss from 'pg-boss';
import { sql } from 'drizzle-orm';

import { JOB } from '../index';
import { db } from '../../db/index';
import { FxService } from '../../fx/fx.service';
import { loggerFor } from '../../logging/logger';

const log = loggerFor('jobs:ledger');

export interface ReconcileResult {
  tripsChecked: number;
  violations: { tripId: string; residualMinor: string }[];
}

/**
 * Assert the zero-sum invariant across every trip with expenses.
 *
 * Exported so it can be unit-tested and invoked directly from the cron route
 * without going through the queue.
 */
export async function reconcileLedgers(): Promise<ReconcileResult> {
  const result = await db.execute<{ trip_id: string; residual: string }>(sql`
    with per_trip as (
      select e.trip_id,
             coalesce(sum(ep.amount_base_minor), 0) as paid,
             0::bigint as owed
        from expenses e
        join expense_payments ep on ep.expense_id = e.id
       where e.deleted_at is null
       group by e.trip_id
      union all
      select e.trip_id,
             0::bigint as paid,
             coalesce(sum(es.share_amount_base_minor), 0) as owed
        from expenses e
        join expense_shares es on es.expense_id = e.id
       where e.deleted_at is null
       group by e.trip_id
    )
    select trip_id,
           (sum(paid) - sum(owed))::text as residual
      from per_trip
     group by trip_id
    having sum(paid) <> sum(owed)
  `);

  const violations = (result.rows ?? []).map((row) => ({
    tripId: row.trip_id,
    residualMinor: row.residual,
  }));

  const counted = await db.execute<{ count: string }>(sql`
    select count(distinct trip_id)::text as count
      from expenses where deleted_at is null
  `);

  const tripsChecked = Number(counted.rows?.[0]?.count ?? '0');

  if (violations.length > 0) {
    // Deliberately `error` level: this is a P1. Sentry picks it up and it is
    // the one alert worth being woken by.
    log.error(
      { violations, tripsChecked },
      'LEDGER INVARIANT VIOLATION — settle-up is unsafe for the affected trips',
    );
  } else {
    log.info({ tripsChecked }, 'ledger reconciliation clean');
  }

  return { tripsChecked, violations };
}

/**
 * Nudge unconfirmed settlements older than 7 days (FR-SPLIT-29).
 * Confirmation is not required for a balance to update, so this is a gentle
 * reminder rather than a blocker.
 */
export async function nudgeUnconfirmedSettlements(): Promise<number> {
  const result = await db.execute<{ count: string }>(sql`
    with stale as (
      select s.id
        from settlements s
       where s.voided_at is null
         and s.confirmed_by_payee = false
         and s.settled_at < now() - interval '7 days'
    )
    select count(*)::text as count from stale
  `);

  const count = Number(result.rows?.[0]?.count ?? '0');
  if (count > 0) log.info({ count }, 'stale unconfirmed settlements found');
  return count;
}

export async function registerLedgerJobs(boss: PgBoss): Promise<void> {
  await boss.work(JOB.LEDGER_RECONCILE, async () => {
    await reconcileLedgers();
  });

  await boss.work(JOB.SETTLEMENT_NUDGE, async () => {
    await nudgeUnconfirmedSettlements();
  });

  await boss.work(JOB.FX_REFRESH, async () => {
    await new FxService().refreshFromProvider('INR');
  });
}
