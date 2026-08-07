/**
 * HTTP test client.
 *
 * One Express instance for the whole suite, driven through supertest in-process
 * — no port binding, no network, no frontend. This is the "API test" layer from
 * DEVELOPMENT_FLOW.md §1, and it is precisely the layer that does NOT need a
 * frontend to exist.
 */

import supertest from 'supertest';

import { buildApp } from '../../src/app';

const app = buildApp();

export const api = supertest(app);

/** `authed(token).get('/v1/…')` — saves repeating the header everywhere. */
export function authed(token: string) {
  const withAuth = (req: supertest.Test) => req.set('Authorization', `Bearer ${token}`);

  return {
    get: (url: string) => withAuth(api.get(url)),
    post: (url: string) => withAuth(api.post(url)),
    patch: (url: string) => withAuth(api.patch(url)),
    put: (url: string) => withAuth(api.put(url)),
    delete: (url: string) => withAuth(api.delete(url)),
  };
}

/** Sum a balances response. The invariant every ledger test asserts. */
export function sumNet(balances: { netMinor: string }[]): bigint {
  return balances.reduce((total, row) => total + BigInt(row.netMinor), 0n);
}

export { app };
