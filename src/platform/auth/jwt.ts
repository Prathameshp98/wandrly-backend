/**
 * Supabase JWT verification.
 *
 * TECHNICAL_DESIGN §7 and §14: we verify the token and derive `ctx.userId` from
 * its `sub`. We never trust a user id supplied in a request body, and we never
 * delegate *authorization* to Supabase — that is the policy engine's job.
 */

import jwt, { type JwtPayload } from 'jsonwebtoken';

import { env } from '../config/env';
import { InvalidTokenError } from '../errors/AppError';
import { loggerFor } from '../logging/logger';

const log = loggerFor('auth');

export interface VerifiedToken {
  readonly userId: string;
  readonly email: string | null;
  readonly expiresAt: number | null;
}

interface JwksKey {
  kid: string;
  kty: string;
  alg?: string;
  n?: string;
  e?: string;
  x5c?: string[];
}

/** Simple JWKS cache. One instance, low traffic — a Map is the right tool. */
const jwksCache = new Map<string, string>();
let jwksFetchedAt = 0;
const JWKS_TTL_MS = 10 * 60 * 1000;

async function loadJwks(): Promise<void> {
  if (!env.SUPABASE_JWKS_URL) return;
  if (Date.now() - jwksFetchedAt < JWKS_TTL_MS && jwksCache.size > 0) return;

  const response = await fetch(env.SUPABASE_JWKS_URL, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    log.error({ status: response.status }, 'failed to fetch JWKS');
    return;
  }

  const { keys } = (await response.json()) as { keys: JwksKey[] };
  jwksCache.clear();

  for (const key of keys) {
    const cert = key.x5c?.[0];
    if (key.kid && cert) {
      jwksCache.set(key.kid, `-----BEGIN CERTIFICATE-----\n${cert}\n-----END CERTIFICATE-----`);
    }
  }

  jwksFetchedAt = Date.now();
}

function extractUser(payload: JwtPayload): VerifiedToken {
  const userId = typeof payload.sub === 'string' ? payload.sub : null;
  if (!userId) throw new InvalidTokenError('Token is missing a subject claim');

  const email =
    typeof payload.email === 'string'
      ? payload.email
      : typeof (payload as { user_metadata?: { email?: string } }).user_metadata?.email === 'string'
        ? (payload as { user_metadata: { email: string } }).user_metadata.email
        : null;

  return { userId, email, expiresAt: payload.exp ?? null };
}

/**
 * Verify an access token.
 *
 * Supports both Supabase configurations: a shared HS256 secret (the documented
 * default) and asymmetric keys via JWKS. Which one applies is decided by env,
 * validated at boot in `config/env.ts`.
 */
export async function verifyAccessToken(token: string): Promise<VerifiedToken> {
  try {
    if (env.SUPABASE_JWT_SECRET) {
      const payload = jwt.verify(token, env.SUPABASE_JWT_SECRET, {
        algorithms: ['HS256'],
        audience: env.JWT_AUDIENCE,
      }) as JwtPayload;
      return extractUser(payload);
    }

    await loadJwks();

    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded?.header.kid;
    const publicKey = kid ? jwksCache.get(kid) : undefined;

    if (!publicKey) throw new InvalidTokenError('Unrecognised token signing key');

    const payload = jwt.verify(token, publicKey, {
      algorithms: ['RS256', 'ES256'],
      audience: env.JWT_AUDIENCE,
    }) as JwtPayload;

    return extractUser(payload);
  } catch (error) {
    if (error instanceof InvalidTokenError) throw error;

    if (error instanceof jwt.TokenExpiredError) {
      throw new InvalidTokenError('Your session has expired. Please sign in again.');
    }

    log.debug({ err: error }, 'token verification failed');
    throw new InvalidTokenError();
  }
}

/** Pull a bearer token out of the Authorization header. */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim() || null;
}
