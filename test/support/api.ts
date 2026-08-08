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

/**
 * Make a status mismatch say *why*.
 *
 * supertest's own message is `expected 204 "No Content", got 404 "Not Found"`
 * and it throws the body away — so a failure tells you the status changed and
 * nothing about the cause. Every error this API returns carries a code and a
 * message (`platform/http/errorHandler`), and for a 404 that message is the
 * difference between "Trip not found" (the access middleware) and "Block not
 * found" (the service) — two unrelated bugs behind one status code.
 *
 * This cost real time chasing an intermittent 404: the failure was reproducible
 * only every ~20 runs, and each occurrence taught nothing. Patching the
 * assertion once fixes that for all call sites without touching any of them.
 */
interface StatusAsserter {
  method?: string;
  url?: string;
  _assertStatus(status: number, res: supertest.Response): Error | undefined;
}

const prototype = supertest.Test.prototype as unknown as StatusAsserter;
const originalAssertStatus = prototype._assertStatus;

prototype._assertStatus = function _assertStatus(
  this: StatusAsserter,
  status: number,
  res: supertest.Response,
): Error | undefined {
  const error = originalAssertStatus.call(this, status, res);
  if (!error) return error;

  const body = res.body as Record<string, unknown> | undefined;
  const detail =
    body && Object.keys(body).length > 0
      ? JSON.stringify(body)
      : String(res.text ?? '').slice(0, 200) || '<empty body>';

  error.message = `${error.message}\n  ${this.method ?? '?'} ${this.url ?? '?'}\n  body: ${detail}`;
  return error;
};

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
