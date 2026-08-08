/**
 * Trip access resolution middleware.
 *
 * TECHNICAL_DESIGN §8.1: this is the ONLY way a trip-scoped route runs. It
 * reads `:tripId`, loads the access object in a single query, asserts the
 * policy, and attaches the result to `req`.
 *
 * A route that forgets it cannot reach a service, because every trip-scoped
 * service method requires a `TripAccess` argument that only this middleware
 * produces. That is Dependency Inversion doing real work: the compiler enforces
 * the authorization boundary.
 */

import type { RequestHandler } from 'express';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { db } from '../db/index';
import { tripMembers, tripParticipants, trips } from '../db/schema/index';
import { NotFoundError } from '../errors/AppError';
import { assert, assertMutable, type Action, type Role, type TripAccess } from '../policy/index';

/**
 * Resolve one actor's relationship to one trip.
 *
 * Returns `null` rather than throwing, so the caller decides between 404 and
 * 403 — and per §8.4 it always chooses 404, so the API never confirms that a
 * trip the caller cannot see exists.
 */
export async function loadTripAccess(
  userId: string,
  tripId: string,
): Promise<TripAccess | null> {
  const rows = await db
    .select({
      tripId: trips.id,
      tripMode: trips.tripMode,
      baseCurrency: trips.baseCurrency,
      isArchived: trips.isArchived,
      role: tripMembers.role,
      participantId: tripParticipants.id,
    })
    .from(trips)
    .innerJoin(
      tripMembers,
      and(eq(tripMembers.tripId, trips.id), eq(tripMembers.userId, userId)),
    )
    .leftJoin(
      tripParticipants,
      and(
        eq(tripParticipants.tripId, trips.id),
        eq(tripParticipants.userId, userId),
        eq(tripParticipants.isActive, true),
      ),
    )
    .where(and(eq(trips.id, tripId), isNull(trips.deletedAt)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    tripId: row.tripId,
    userId,
    role: row.role as Role,
    participantId: row.participantId ?? null,
    tripMode: row.tripMode,
    baseCurrency: row.baseCurrency,
    isArchived: row.isArchived,
  };
}

export interface TripAccessOptions {
  /** Route param holding the trip id. Defaults to `tripId`. */
  readonly param?: string;
  /** Reject the request when the trip is archived (read-only). */
  readonly requireMutable?: boolean;
}

/**
 * Marks a handler as an authorization guard.
 *
 * The compiler already stops a route reaching a service without a `TripAccess`
 * (see the header comment), but it cannot see a route that never calls a
 * service at all. `route-contract.test.ts` walks the router stack looking for
 * this, which catches the gap the type system structurally cannot.
 */
const TRIP_GUARD = Symbol.for('wandrly.tripAccessGuard');

function markGuard(handler: RequestHandler): RequestHandler {
  Object.defineProperty(handler, TRIP_GUARD, { value: true });
  return handler;
}

export const isTripAccessGuard = (fn: unknown): boolean =>
  typeof fn === 'function' && TRIP_GUARD in (fn as object);

/**
 * Load access for `:tripId` and assert `action`.
 *
 * @example
 *   router.post('/trips/:tripId/expenses',
 *     validate({ params: TripIdParam, body: CreateExpenseBody }),
 *     withTripAccess('expense:create'),
 *     handler);
 */
export function withTripAccess(
  action: Action,
  options: TripAccessOptions = {},
): RequestHandler {
  const param = options.param ?? 'tripId';

  return markGuard(async (req, _res, next) => {
    try {
      const tripId = req.params[param];
      if (typeof tripId !== 'string' || !tripId) throw new NotFoundError('Trip');

      const access = await loadTripAccess(req.ctx.userId, tripId);
      if (!access) throw new NotFoundError('Trip');

      assert(access, action);
      if (options.requireMutable !== false) assertMutable(access);

      req.access = access;
      next();
    } catch (error) {
      next(error);
    }
  });
}

/** Same, but permits archived trips — used by read routes. */
export const withTripRead = (action: Action = 'trip:view'): RequestHandler =>
  withTripAccess(action, { requireMutable: false });

/**
 * Resolve access from a nested resource rather than a `:tripId` param.
 *
 * Blocks, days, and expenses are addressed by their own id, so the trip must be
 * resolved by walking up the ownership chain. The resolver is injected so this
 * middleware stays ignorant of the schema — Single Responsibility.
 */
export function withResolvedTripAccess(
  action: Action,
  resolveTripId: (resourceId: string) => Promise<string | null>,
  options: { param?: string; requireMutable?: boolean } = {},
): RequestHandler {
  const param = options.param ?? 'id';

  return markGuard(async (req, _res, next) => {
    try {
      const resourceId = req.params[param];
      if (typeof resourceId !== 'string' || !resourceId) {
        throw new NotFoundError('Resource');
      }

      const tripId = await resolveTripId(resourceId);
      if (!tripId) throw new NotFoundError('Resource');

      const access = await loadTripAccess(req.ctx.userId, tripId);
      if (!access) throw new NotFoundError('Resource');

      assert(access, action);
      if (options.requireMutable !== false) assertMutable(access);

      req.access = access;
      next();
    } catch (error) {
      next(error);
    }
  });
}

/** Non-null accessor, for handlers that run behind the middleware above. */
export function accessOf(req: { access?: TripAccess }): TripAccess {
  if (!req.access) {
    // A programming error, not a user error: the route is missing its guard.
    throw new Error('withTripAccess middleware is missing from this route');
  }
  return req.access;
}

/** Count of members, used by limit enforcement. Kept here beside the join above. */
export async function countTripMembers(tripId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tripMembers)
    .where(eq(tripMembers.tripId, tripId));
  return row?.count ?? 0;
}
