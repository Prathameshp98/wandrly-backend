/**
 * Background jobs.
 *
 * TECHNICAL_DESIGN §10 — pg-boss, workers in the API process. No Redis, no
 * separate worker service: at ≤30 concurrent users there is nothing to starve.
 *
 * SCHEDULING IS EXTERNAL (§10.2). A free Koyeb instance can sleep, so an
 * in-process cron would silently stop firing — including the nightly ledger
 * reconciliation, the one job that must never stop. GitHub Actions pokes
 * `/internal/cron/tick`, which enqueues these.
 */

import PgBoss from 'pg-boss';

import { env, isTest } from '../config/env';
import { loggerFor } from '../logging/logger';
import { registerLedgerJobs } from './handlers/ledger.jobs';
import { registerMaintenanceJobs } from './handlers/maintenance.jobs';

const log = loggerFor('jobs');

export const JOB = {
  FX_REFRESH: 'fx.refresh',
  LEDGER_RECONCILE: 'ledger.reconcile',
  SETTLEMENT_NUDGE: 'notify.settlement-nudge',
  EMAIL_SEND: 'email.send',
  NOTIFICATION_BATCH: 'notification.batch',
  PURGE_SOFT_DELETED: 'purge.soft-deleted',
  PURGE_ORPHAN_MEDIA: 'purge.orphan-media',
  PURGE_IDEMPOTENCY: 'purge.idempotency',
  EXPORT_PDF: 'export.pdf',
  EXPORT_CSV: 'export.csv',
} as const;

export type JobName = (typeof JOB)[keyof typeof JOB];

let boss: PgBoss | null = null;

export async function startJobs(): Promise<void> {
  if (isTest) return;

  boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    // Keep the footprint small — this shares a 512 MB container with the API.
    max: 2,
    schema: 'pgboss',
    retryLimit: 3,
    retryBackoff: true,
    // Chromium is not in play (§10.1), so no job needs a long window.
    expireInMinutes: 15,
  });

  boss.on('error', (error) => log.error({ err: error }, 'pg-boss error'));

  await boss.start();

  await registerLedgerJobs(boss);
  await registerMaintenanceJobs(boss);

  log.info('job workers started');
}

export async function stopJobs(): Promise<void> {
  if (!boss) return;
  await boss.stop({ graceful: true, timeout: 5_000 });
  boss = null;
  log.info('job workers stopped');
}

/**
 * Enqueue a job.
 *
 * Returns null when the queue is unavailable rather than throwing: a failure to
 * schedule a background nudge must never fail the user's request.
 */
export async function enqueue<T extends object>(
  name: JobName,
  data?: T,
  options?: PgBoss.SendOptions,
): Promise<string | null> {
  if (!boss) {
    log.debug({ name }, 'queue unavailable; job skipped');
    return null;
  }

  try {
    return await boss.send(name, data ?? {}, options ?? {});
  } catch (error) {
    log.error({ err: error, name }, 'failed to enqueue job');
    return null;
  }
}

export const jobsReady = (): boolean => boss !== null;
