/**
 * WebSocket upgrade authentication.
 *
 * The token arrives as a query parameter because browsers cannot set headers on
 * a WebSocket handshake. It is verified, and trip access is checked, BEFORE the
 * socket is accepted.
 */

import type { IncomingMessage } from 'node:http';

import { InvalidTokenError, NotFoundError } from '../errors/AppError';
import { verifyAccessToken } from '../auth/jwt';
import { loadTripAccess } from '../http/withTripAccess';
import { can } from '../policy/index';

export interface UpgradeIdentity {
  readonly userId: string;
  readonly tripId: string;
}

export async function authenticateUpgrade(req: IncomingMessage): Promise<UpgradeIdentity> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname !== '/realtime') {
    throw new NotFoundError('Realtime endpoint');
  }

  const token = url.searchParams.get('token');
  const tripId = url.searchParams.get('tripId');

  if (!token) throw new InvalidTokenError('Missing token');
  if (!tripId) throw new NotFoundError('Trip');

  const verified = await verifyAccessToken(token);

  const access = await loadTripAccess(verified.userId, tripId);
  if (!access || !can(access, 'trip:view')) {
    // Same response for "no such trip" and "not your trip" (§8.4).
    throw new NotFoundError('Trip');
  }

  return { userId: verified.userId, tripId };
}
