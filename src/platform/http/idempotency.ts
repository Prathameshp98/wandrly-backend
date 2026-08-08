/**
 * Idempotency middleware.
 *
 * TECHNICAL_DESIGN §8.8. Required for expense and settlement creation — a
 * double-tap on a flaky mobile connection must not create two ₹5,000 expenses.
 *
 * Protocol:
 *   • Client sends `Idempotency-Key: <opaque>` on a mutating request.
 *   • First request claims the key atomically and runs normally; its response
 *     is stored.
 *   • A retry with the SAME key and body replays the stored response.
 *   • A retry with the same key but a DIFFERENT body is a client bug → 409.
 *   • A retry while the first is still in flight → 409, rather than running twice.
 *
 * Keys are purged after 24 hours by the maintenance job.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { and, eq, sql } from 'drizzle-orm';

import { db } from '../db/index';
import { idempotencyKeys } from '../db/schema/index';
import { hashPayload } from '../crypto/index';
import { IdempotencyMismatchError } from '../errors/AppError';
import { loggerFor } from '../logging/logger';

const log = loggerFor('idempotency');

const HEADER = 'idempotency-key';
const MAX_KEY_LENGTH = 200;

/** Only 2xx responses are replayable — a failure should be retryable for real. */
const isReplayable = (status: number): boolean => status >= 200 && status < 300;

export function idempotent(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const rawKey = req.headers[HEADER];
    const key = typeof rawKey === 'string' ? rawKey.trim() : null;

    // The header is optional: clients that don't send it get normal behaviour.
    if (!key) {
      next();
      return;
    }

    if (key.length > MAX_KEY_LENGTH) {
      next(new IdempotencyMismatchError());
      return;
    }

    const userId = req.ctx.userId;
    const route = `${req.method} ${req.route?.path ?? req.path}`;
    const requestHash = hashPayload({ route, body: req.body ?? null });
    const scopedKey = `${userId}:${key}`;

    try {
      // Atomically claim the key. ON CONFLICT DO NOTHING means exactly one
      // concurrent request wins; the others fall through to the replay path.
      const claimed = await db
        .insert(idempotencyKeys)
        .values({ key: scopedKey, userId, route, requestHash })
        .onConflictDoNothing()
        .returning({ key: idempotencyKeys.key });

      if (claimed.length === 0) {
        await replayOrReject(scopedKey, requestHash, res, next);
        return;
      }
    } catch (error) {
      // Never let the idempotency store break the request it is protecting.
      log.error({ err: error, route }, 'failed to claim idempotency key; proceeding');
      next();
      return;
    }

    captureResponse(req, res, scopedKey, route);
    next();
  };
}

/** A key that already exists: replay its stored response, or reject. */
async function replayOrReject(
  scopedKey: string,
  requestHash: string,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const rows = await db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, scopedKey))
    .limit(1);

  const existing = rows[0];

  if (!existing) {
    // Raced with the purge job. Treat as a fresh request.
    next();
    return;
  }

  if (existing.requestHash !== requestHash) {
    next(new IdempotencyMismatchError());
    return;
  }

  if (existing.statusCode === null || existing.response === null) {
    // The original is still in flight. Returning 409 is safer than running the
    // mutation a second time and hoping the first one loses.
    res.status(409).json({
      error: {
        code: 'CONFLICT_DUPLICATE',
        message: 'An identical request is still being processed. Retry shortly.',
      },
    });
    return;
  }

  log.debug({ scopedKey }, 'replaying stored idempotent response');
  res.status(existing.statusCode).set('Idempotent-Replay', 'true');
  res.json(JSON.parse(existing.response));
}

/**
 * Persist the outgoing response against the key, BEFORE the bytes go out.
 *
 * The ordering here is the whole contract. An earlier version stored the
 * response with `background()` — fire-and-forget — and responded immediately.
 * That left a window in which the key was claimed but its `statusCode` was
 * still NULL, and a retry landing inside it took the "original still in
 * flight" branch and got **409 instead of the replay it asked for**.
 *
 * The window is small, so it read as an intermittent test failure rather than
 * as what it is: on a flaky mobile connection, a client's automatic retry is
 * *most* likely to arrive exactly then. Idempotency exists so a retry is safe;
 * answering it with a conflict is the one thing it must never do.
 *
 * So the write is awaited. `res.end` is the hook rather than `res.json`
 * because everything funnels through it — `json` → `send` → `end`, and a 204
 * calls it directly — which is also why the 204 case no longer needs a
 * separate `finish` listener that fired *after* the response had already gone.
 */
function captureResponse(
  req: Request,
  res: Response,
  scopedKey: string,
  route: string,
): void {
  const originalJson = res.json.bind(res);
  const originalEnd = res.end.bind(res);

  let body: unknown = null;
  let hasBody = false;

  res.json = (value: unknown): Response => {
    body = value;
    hasBody = true;
    return originalJson(value);
  };

  let finalising = false;

  res.end = function patchedEnd(this: Response, ...args: unknown[]): Response {
    // Express can reach `end` more than once (HEAD, aborted writes). Persist
    // once; let everything after through untouched.
    if (finalising) return originalEnd(...(args as Parameters<typeof originalEnd>));
    finalising = true;

    const status = res.statusCode;

    const write = isReplayable(status)
      ? db
          .update(idempotencyKeys)
          .set({ statusCode: status, response: hasBody ? JSON.stringify(body) : 'null' })
          .where(eq(idempotencyKeys.key, scopedKey))
      : // A non-2xx releases the key, so a genuine failure stays retryable
        // rather than replaying an error forever.
        db
          .delete(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.key, scopedKey),
              sql`${idempotencyKeys.statusCode} is null`,
            ),
          );

    void Promise.resolve(write)
      .catch((error: unknown) => {
        // Never fail the request over its own bookkeeping — the mutation has
        // already happened and the client is entitled to hear about it.
        log.error({ err: error, route }, 'failed to persist idempotent response');
      })
      .finally(() => {
        originalEnd(...(args as Parameters<typeof originalEnd>));
      });

    return res;
  } as typeof res.end;

  void req;
}
