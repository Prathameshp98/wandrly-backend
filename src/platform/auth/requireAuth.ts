/**
 * Authentication middleware and the internal-cron guard.
 *
 * TECHNICAL_DESIGN §7, §10.2.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { env } from '../config/env';
import { AuthRequiredError, ForbiddenError } from '../errors/AppError';
import { newRequestId, safeEqual } from '../crypto/index';
import { bearerFrom, verifyAccessToken } from './jwt';
import type { UserSyncService } from '../../modules/auth/user-sync.service';

/**
 * Verify the bearer token and populate `req.ctx`.
 *
 * Also lazily mirrors the Supabase identity into our own `users` table
 * (decision T-2), so joins stay local and the exit path off Supabase survives.
 * The sync is fire-and-forget on the happy path — a failure to update
 * `lastSeenAt` must never fail a request.
 */
export function requireAuth(userSync: UserSyncService): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = bearerFrom(req.headers.authorization);
      if (!token) throw new AuthRequiredError();

      const verified = await verifyAccessToken(token);

      req.ctx = {
        userId: verified.userId,
        requestId: String(req.id ?? newRequestId()),
      };

      // Ensures a local row exists on first contact after signup.
      await userSync.ensureUser(verified);

      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Guard for `/internal/cron/*` (§10.2).
 *
 * Compared in constant time, excluded from the OpenAPI spec, and rate-limited
 * separately. GitHub Actions is the only intended caller.
 */
export const cronSecretAuth: RequestHandler = (req, _res, next) => {
  const provided =
    bearerFrom(req.headers.authorization) ?? (req.headers['x-cron-secret'] as string | undefined);

  if (!provided || !safeEqual(provided, env.CRON_SECRET)) {
    next(new ForbiddenError('cron'));
    return;
  }

  req.ctx = { userId: 'system:cron', requestId: String(req.id ?? newRequestId()) };
  next();
};

/**
 * Optional authentication, for routes that behave differently when signed in.
 * Used by public share pages so a logged-in owner previewing their own link
 * still gets a normal experience.
 */
export function optionalAuth(userSync: UserSyncService): RequestHandler {
  return async (req, _res, next) => {
    const token = bearerFrom(req.headers.authorization);
    if (!token) {
      next();
      return;
    }

    try {
      const verified = await verifyAccessToken(token);
      req.ctx = { userId: verified.userId, requestId: String(req.id ?? newRequestId()) };
      await userSync.ensureUser(verified);
    } catch {
      // A bad token on an optional route is simply "not signed in".
    }

    next();
  };
}
