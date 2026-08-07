/**
 * Supabase JWT verification.
 *
 * TECHNICAL_DESIGN §7 and §14: we verify the token and derive `ctx.userId` from
 * its `sub`. We never trust a user id supplied in a request body, and we never
 * delegate *authorization* to Supabase — that is the policy engine's job.
 */

import { createPublicKey, type KeyObject } from 'node:crypto';

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
  kid?: string;
  kty?: string;
  alg?: string;
  crv?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  x5c?: string[];
}

/** Simple JWKS cache. One instance, low traffic — a Map is the right tool. */
const jwksCache = new Map<string, KeyObject>();
let jwksFetchedAt = 0;
const JWKS_TTL_MS = 10 * 60 * 1000;

/** Floor between out-of-band refetches triggered by an unrecognised `kid`. */
let lastForcedRefreshAt = 0;
const FORCED_REFRESH_MIN_INTERVAL_MS = 60 * 1000;

/**
 * Turn one JWKS entry into a verification key.
 *
 * Supabase publishes *bare* JWKs — an ES256 key is `{kty:'EC', crv:'P-256', x,
 * y}` with no `x5c` member. An earlier version of this read only `x5c`, so every
 * key was skipped and every token rejected as "unrecognised signing key". Node
 * imports a bare JWK directly; `x5c` stays as a fallback for providers that
 * publish certificate chains instead.
 */
function toKeyObject(key: JwksKey): KeyObject | null {
  try {
    if (key.kty === 'EC' || key.kty === 'RSA' || key.kty === 'OKP') {
      // Node validates the JWK and ignores non-cryptographic members
      // (`use`, `key_ops`, `ext`, `kid`), which Supabase does include.
      return createPublicKey({ key: key as never, format: 'jwk' });
    }

    const cert = key.x5c?.[0];
    if (cert) {
      return createPublicKey(`-----BEGIN CERTIFICATE-----\n${cert}\n-----END CERTIFICATE-----`);
    }
  } catch (error) {
    log.warn({ err: error, kid: key.kid, kty: key.kty }, 'unusable JWKS entry, skipping');
  }

  return null;
}

async function loadJwks(): Promise<void> {
  if (!env.SUPABASE_JWKS_URL) return;
  if (Date.now() - jwksFetchedAt < JWKS_TTL_MS && jwksCache.size > 0) return;

  const response = await fetch(env.SUPABASE_JWKS_URL, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    log.error({ status: response.status }, 'failed to fetch JWKS');
    return;
  }

  const { keys } = (await response.json()) as { keys: JwksKey[] };

  // Build into a fresh Map so a malformed response cannot empty a working
  // cache — rotation should replace keys, never leave us with none.
  const next = new Map<string, KeyObject>();
  for (const key of keys ?? []) {
    if (!key.kid) continue;
    const publicKey = toKeyObject(key);
    if (publicKey) next.set(key.kid, publicKey);
  }

  if (next.size === 0) {
    log.error({ received: keys?.length ?? 0 }, 'JWKS had no usable keys, keeping cache');
    return;
  }

  jwksCache.clear();
  for (const [kid, publicKey] of next) jwksCache.set(kid, publicKey);
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
    let publicKey = kid ? jwksCache.get(kid) : undefined;

    // An unknown kid usually means Supabase rotated its signing key inside our
    // TTL. Refetch rather than rejecting valid tokens for ten minutes — but at
    // most once a minute, so forged tokens carrying random kids cannot turn
    // this into a fetch amplifier aimed at the JWKS endpoint.
    if (!publicKey && kid && Date.now() - lastForcedRefreshAt > FORCED_REFRESH_MIN_INTERVAL_MS) {
      lastForcedRefreshAt = Date.now();
      jwksFetchedAt = 0;
      await loadJwks();
      publicKey = jwksCache.get(kid);
    }

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
