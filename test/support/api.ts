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

/**
 * Patch once, however many times this module is evaluated.
 *
 * `isolate: true` gives every test file its own module registry, so this file
 * runs once per file — but `supertest` resolves to one cached instance, so the
 * prototype is shared. Without this guard each file wraps the previous wrapper
 * and a failure in the twelfth file prints its diagnostic twelve times.
 */
const PATCHED = Symbol.for('wandrly.assertStatusPatched');

if (!(PATCHED in prototype)) {
  Object.defineProperty(prototype, PATCHED, { value: true });
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

    // Content-Type earns its place here: this API's error handler ALWAYS emits
    // a JSON payload, so an error response with no body did not come from the
    // application at all — a distinction worth seeing at the moment of failure
    // rather than deducing later.
    const contentType = res.headers?.['content-type'] ?? '<none>';

    error.message =
      `${error.message}\n  ${this.method ?? '?'} ${this.url ?? '?'}` +
      `\n  content-type: ${contentType}\n  body: ${detail}`;
    return error;
  };
}

const app = buildApp();

/**
 * Bind ONE listening server per test file, rather than one per request.
 *
 * supertest's `serverAddress` does `if (!addr) this._server = app.listen(0)`
 * and its `end` closes that server again — so handing it a bare Express app
 * opens and closes a fresh ephemeral port **for every single request**. Across
 * this suite that is several thousand bind/close cycles per run.
 *
 * That churn is the best remaining explanation for the suite's long-standing
 * intermittent 404: the failures come back with **no content-type and no
 * body**, and this app's error handler always emits JSON, so the response
 * never came from Express. A request landing on a just-recycled ephemeral port
 * — or written to a pooled keep-alive socket whose server has since closed —
 * produces exactly that.
 *
 * Passing an already-listening server makes `app.address()` non-null, so
 * supertest never sets `_server` and never opens or closes anything per
 * request. `unref()` keeps the handle from holding the process open once the
 * file's tests are done.
 *
 * `listen()` binds its handle synchronously, so `address()` is valid on the
 * next line even though `listening` has not been emitted yet.
 */
const server = app.listen(0);
server.unref();

export const api = supertest(server);

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
