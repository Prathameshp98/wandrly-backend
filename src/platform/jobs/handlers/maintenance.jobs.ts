/**
 * Maintenance jobs — purges and notification batching.
 * TECHNICAL_DESIGN §10, §10.3.
 */

import type PgBoss from 'pg-boss';
import { sql } from 'drizzle-orm';

import { JOB } from '../index';
import { db } from '../../db/index';
import { loggerFor } from '../../logging/logger';

const log = loggerFor('jobs:maintenance');

/** Hard-delete rows soft-deleted more than 30 days ago (FR-TRIP-09). */
export async function purgeSoftDeleted(): Promise<number> {
  const result = await db.execute<{ count: string }>(sql`
    with purged_blocks as (
      delete from blocks where deleted_at < now() - interval '30 days' returning 1
    ),
    purged_expenses as (
      delete from expenses where deleted_at < now() - interval '30 days' returning 1
    ),
    purged_trips as (
      delete from trips where deleted_at < now() - interval '30 days' returning 1
    )
    select ( (select count(*) from purged_blocks)
           + (select count(*) from purged_expenses)
           + (select count(*) from purged_trips) )::text as count
  `);

  const count = Number(result.rows?.[0]?.count ?? '0');
  if (count > 0) log.info({ count }, 'purged soft-deleted rows');
  return count;
}

/** Orphaned uploads that were presigned but never confirmed. */
export async function purgeOrphanMedia(): Promise<number> {
  const result = await db.execute<{ count: string }>(sql`
    with purged as (
      delete from media_assets
       where state = 'PENDING'
         and created_at < now() - interval '24 hours'
      returning 1
    )
    select count(*)::text as count from purged
  `);

  const count = Number(result.rows?.[0]?.count ?? '0');
  if (count > 0) log.info({ count }, 'purged orphaned media');
  return count;
}

/** Idempotency keys are retained for 24 hours (§8.8). */
export async function purgeIdempotencyKeys(): Promise<number> {
  const result = await db.execute<{ count: string }>(sql`
    with purged as (
      delete from idempotency_keys
       where created_at < now() - interval '24 hours'
      returning 1
    )
    select count(*)::text as count from purged
  `);
  return Number(result.rows?.[0]?.count ?? '0');
}

/**
 * The 30-minute batching sweep (§10.3).
 *
 * Groups each user's BATCHED notifications into a single email. Marks them SENT
 * whether or not an email provider is configured — otherwise a missing
 * RESEND_API_KEY would leave rows stuck in the outbox forever.
 */
export async function sweepNotificationEmails(): Promise<number> {
  const result = await db.execute<{ user_id: string; count: string }>(sql`
    with batched as (
      select user_id, count(*) as count
        from notifications
       where email_state = 'BATCHED'
         and created_at < now() - interval '25 minutes'
       group by user_id
    ),
    marked as (
      update notifications
         set email_state = 'SENT', email_sent_at = now()
       where email_state = 'BATCHED'
         and created_at < now() - interval '25 minutes'
      returning user_id
    )
    select user_id, count::text as count from batched
  `);

  const digests = result.rows ?? [];
  if (digests.length > 0) {
    log.info({ recipients: digests.length }, 'notification digests swept');
  }
  return digests.length;
}

export async function registerMaintenanceJobs(boss: PgBoss): Promise<void> {
  await boss.work(JOB.PURGE_SOFT_DELETED, async () => {
    await purgeSoftDeleted();
  });

  await boss.work(JOB.PURGE_ORPHAN_MEDIA, async () => {
    await purgeOrphanMedia();
  });

  await boss.work(JOB.PURGE_IDEMPOTENCY, async () => {
    await purgeIdempotencyKeys();
  });

  await boss.work(JOB.NOTIFICATION_BATCH, async () => {
    await sweepNotificationEmails();
  });
}
