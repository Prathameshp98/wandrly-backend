/**
 * Internal cron endpoint.
 *
 * TECHNICAL_DESIGN §10.2. GitHub Actions calls this; it enqueues work and
 * returns immediately — `curl` should not be waiting on a reconciliation sweep.
 *
 * The request also wakes the container, which keeps both Koyeb and the Supabase
 * free tier from idling out. That keepalive is a side effect of work that needed
 * doing anyway, not a hack bolted on.
 */

import { Router } from 'express';
import { z } from 'zod';

import { JOB, enqueue } from './index';
import { validate, validated } from '../http/validate';
import { loggerFor } from '../logging/logger';
import { reconcileLedgers } from './handlers/ledger.jobs';

const log = loggerFor('cron');

export const cronRouter = Router();

const TickBody = z.object({
  /**
   * Which task group to run. `daily` is the 02:00 IST sweep; `frequent` is the
   * 30-minute notification batch.
   */
  group: z.enum(['daily', 'frequent', 'hourly']).default('daily'),
  /** Run reconciliation inline and return the result — for manual checks. */
  inline: z.boolean().default(false),
});

const GROUPS = {
  daily: [
    JOB.FX_REFRESH,
    JOB.LEDGER_RECONCILE,
    JOB.SETTLEMENT_NUDGE,
    JOB.PURGE_SOFT_DELETED,
    JOB.PURGE_ORPHAN_MEDIA,
    JOB.PURGE_IDEMPOTENCY,
  ],
  hourly: [JOB.NOTIFICATION_BATCH],
  frequent: [JOB.NOTIFICATION_BATCH],
} as const;

cronRouter.post('/tick', validate({ body: TickBody }), async (req, res) => {
  const { group, inline } = validated.body(req, TickBody);

  // Inline mode exists so you can verify the invariant by hand without waiting
  // for a worker, and so a monitoring probe can assert on the response.
  if (inline) {
    const result = await reconcileLedgers();
    res.json({ group, ran: 'ledger.reconcile', ...result });
    return;
  }

  const queued: string[] = [];
  for (const job of GROUPS[group]) {
    const id = await enqueue(job);
    if (id) queued.push(job);
  }

  log.info({ group, queued }, 'cron tick');
  res.status(202).json({ group, queued });
});

/** Liveness for the scheduler itself, so a failing tick is visible in Actions. */
cronRouter.get('/ping', (_req, res) => {
  res.json({ ok: true, at: new Date().toISOString() });
});
