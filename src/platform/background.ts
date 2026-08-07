/**
 * Background write tracking.
 *
 * A few writes are deliberately fire-and-forget — a share-link view counter must
 * never slow or fail the page it is counting. But an untracked floating promise
 * can still be in flight after its request ends, which makes behaviour
 * non-deterministic for anything that needs to know the world has settled.
 *
 * Registering them costs nothing in production and lets tests drain the queue
 * before asserting or resetting. It surfaced as an intermittent 404: an expense
 * created by one test was wiped by a truncate that a stale background write had
 * delayed.
 */

import { loggerFor } from './logging/logger';

const log = loggerFor('background');

const pending = new Set<Promise<unknown>>();

/**
 * Run a promise in the background, swallowing its error.
 *
 * Use only where failure is genuinely acceptable — counters, cache warms.
 * Never for anything a user would notice going missing.
 */
export function background<T>(work: Promise<T>, label: string): void {
  const tracked = work
    .catch((error: unknown) => {
      log.warn({ err: error, label }, 'background write failed');
    })
    .finally(() => {
      pending.delete(tracked);
    });

  pending.add(tracked);
}

/** Wait for every in-flight background write. Used by tests and on shutdown. */
export async function drainBackground(): Promise<void> {
  while (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
}

export const pendingBackgroundCount = (): number => pending.size;
