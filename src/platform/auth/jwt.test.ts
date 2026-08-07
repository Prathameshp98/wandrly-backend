/**
 * JWKS verification.
 *
 * Supabase projects created from 2025 onward sign with asymmetric keys and
 * publish *bare* JWKs — an ES256 entry is `{kty:'EC', crv:'P-256', x, y}` with
 * no `x5c` member. The first implementation here read only `x5c`, so every key
 * was silently skipped and every token was rejected. These tests pin the bare-
 * JWK path so that regression cannot come back.
 */

import { generateKeyPairSync, type KeyObject } from 'node:crypto';

import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Partial mock: only the two auth fields change. `.env.test` sets an HS256
// secret, which would send every call down the symmetric branch and leave the
// JWKS path — the one that broke — untested.
vi.mock('../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      SUPABASE_JWT_SECRET: undefined,
      SUPABASE_JWKS_URL: 'https://example.supabase.co/auth/v1/.well-known/jwks.json',
    },
  };
});

type JwtModule = typeof import('./jwt');

/**
 * The JWKS cache, its TTL stamp and the forced-refresh floor are module-level
 * state. Re-importing per test is what keeps them from leaking: without it, a
 * key cached by one test satisfies the next one's TTL and the refresh paths
 * never execute.
 */
let verifyAccessToken: JwtModule['verifyAccessToken'];
let bearerFrom: JwtModule['bearerFrom'];

interface Keypair {
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function es256Keypair(kid: string): Keypair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  return {
    privateKey,
    // Shaped exactly like a real Supabase entry, extra members included — Node
    // must tolerate `ext`/`key_ops`/`use` alongside the cryptographic members.
    jwk: {
      ...publicKey.export({ format: 'jwk' }),
      kid,
      alg: 'ES256',
      use: 'sig',
      ext: true,
      key_ops: ['verify'],
    },
  };
}

function sign(pair: Keypair, kid: string, claims: Record<string, unknown> = {}): string {
  return jwt.sign(
    {
      sub: 'user-abc',
      email: 'traveller@example.com',
      aud: 'authenticated',
      ...claims,
    },
    pair.privateKey,
    {
      algorithm: 'ES256',
      keyid: kid,
      expiresIn: '1h',
    },
  );
}

function serveJwks(...jwks: Record<string, unknown>[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ keys: jwks }), { status: 200 })),
  );
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  vi.resetModules();
  ({ verifyAccessToken, bearerFrom } = await import('./jwt'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('verifyAccessToken with a JWKS', () => {
  it('accepts a token signed by a bare ES256 JWK (no x5c)', async () => {
    const kid = 'kid-es256';
    const pair = es256Keypair(kid);
    serveJwks(pair.jwk);

    const result = await verifyAccessToken(sign(pair, kid));

    expect(result.userId).toBe('user-abc');
    expect(result.email).toBe('traveller@example.com');
  });

  it('accepts a token signed by a bare RS256 JWK', async () => {
    const kid = 'kid-rs256';
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    serveJwks({
      ...publicKey.export({ format: 'jwk' }),
      kid,
      alg: 'RS256',
      use: 'sig',
    });

    const token = jwt.sign({ sub: 'user-rsa', aud: 'authenticated' }, privateKey, {
      algorithm: 'RS256',
      keyid: kid,
      expiresIn: '1h',
    });

    await expect(verifyAccessToken(token)).resolves.toMatchObject({
      userId: 'user-rsa',
    });
  });

  it('rejects a token signed by a key the JWKS does not publish', async () => {
    const published = es256Keypair('kid-published');
    const attacker = es256Keypair('kid-published'); // same kid, different key
    serveJwks(published.jwk);

    await expect(verifyAccessToken(sign(attacker, 'kid-published'))).rejects.toThrow();
  });

  it('rejects a token whose audience does not match', async () => {
    const kid = 'kid-aud';
    const pair = es256Keypair(kid);
    serveJwks(pair.jwk);

    await expect(verifyAccessToken(sign(pair, kid, { aud: 'someone-else' }))).rejects.toThrow();
  });

  it('refetches once when a rotated kid is not in the cache', async () => {
    const original = es256Keypair('kid-old');
    serveJwks(original.jwk);
    await verifyAccessToken(sign(original, 'kid-old'));

    // Supabase rotates. The new kid is unknown, and the TTL has not expired.
    const rotated = es256Keypair('kid-new');
    serveJwks(rotated.jwk);
    vi.advanceTimersByTime(2 * 60 * 1000); // inside the 10m TTL

    await expect(verifyAccessToken(sign(rotated, 'kid-new'))).resolves.toMatchObject({
      userId: 'user-abc',
    });
  });

  it('does not refetch on every unknown kid, so forged tokens cannot amplify', async () => {
    const pair = es256Keypair('kid-real');
    serveJwks(pair.jwk);
    await verifyAccessToken(sign(pair, 'kid-real'));

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const before = fetchMock.mock.calls.length;

    // A burst of forged tokens, each with a kid we have never seen.
    for (let i = 0; i < 25; i += 1) {
      const forged = es256Keypair(`forged-${i}`);
      await expect(verifyAccessToken(sign(forged, `forged-${i}`))).rejects.toThrow();
    }

    // At most one refetch in the 60s window, not 25.
    expect(fetchMock.mock.calls.length - before).toBeLessThanOrEqual(1);
  });

  it('keeps a working cache when the JWKS endpoint returns no usable keys', async () => {
    const pair = es256Keypair('kid-good');
    serveJwks(pair.jwk);
    await verifyAccessToken(sign(pair, 'kid-good'));

    // TTL expires and the endpoint degrades to garbage.
    serveJwks({
      kid: 'kid-broken',
      kty: 'EC',
      crv: 'P-256',
      x: 'not-base64url!!',
      y: 'also-bad',
    });
    vi.advanceTimersByTime(20 * 60 * 1000);

    // The previously cached key must still verify tokens.
    await expect(verifyAccessToken(sign(pair, 'kid-good'))).resolves.toMatchObject({
      userId: 'user-abc',
    });
  });
});

describe('bearerFrom', () => {
  it.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer abc.def.ghi', 'abc.def.ghi'],
    ['Basic abc', null],
    ['Bearer', null],
    ['Bearer   ', null],
    [undefined, null],
  ])('parses %s', (header, expected) => {
    expect(bearerFrom(header as string | undefined)).toBe(expected);
  });
});
