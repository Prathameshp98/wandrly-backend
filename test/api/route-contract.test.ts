/**
 * Route contract.
 *
 * TECHNICAL_DESIGN §4.4 promises a test that walks the router stack and fails
 * any mutating route missing `validate()`. `IMPLEMENTATION_STATUS.md` listed it
 * as the one outstanding item. This is it, plus its twin for authorization.
 *
 * Why a stack walk rather than review: both rules are invisible at the call
 * site of the thing they protect. A route missing `validate()` still works —
 * it just hands unvalidated input to a service. A trip-scoped route missing its
 * guard still works — it just serves someone else's trip. Neither shows up as a
 * failure until someone writes the specific test that would have caught it, and
 * `openapi-coverage.test.ts` already proved this shape of test finds real drift
 * (62 undocumented routes across three phases).
 */

import { describe, expect, it } from 'vitest';

import { app } from '../support/api';
import { isValidationMiddleware } from '../../src/platform/http/validate';
import { isTripAccessGuard } from '../../src/platform/http/withTripAccess';

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle?: unknown }[];
  };
  handle?: { stack?: unknown[] };
  matchers?: ((input: string) => unknown)[];
}

interface Endpoint {
  readonly method: string;
  readonly path: string;
  readonly handlers: readonly unknown[];
}

const MOUNT_CANDIDATES = ['/v1', '/internal/cron'] as const;

/** See `openapi-coverage.test.ts` — Express 5 hides the mount path behind matchers. */
function mountPrefixOf(layer: RouteLayer): string {
  const match = layer.matchers?.[0];
  if (typeof match !== 'function') return '';

  try {
    if (match('/')) return '';
  } catch {
    return '';
  }

  for (const candidate of MOUNT_CANDIDATES) {
    try {
      if (match(candidate)) return candidate;
    } catch {
      /* not this one */
    }
  }

  return '';
}

function collect(stack: unknown[], prefix = ''): Endpoint[] {
  const found: Endpoint[] = [];

  for (const layer of stack as RouteLayer[]) {
    if (layer.route) {
      const handlers = layer.route.stack.map((entry) => entry.handle);
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        found.push({
          method: method.toUpperCase(),
          path: prefix + layer.route.path,
          handlers,
        });
      }
    } else if (layer.handle?.stack) {
      found.push(...collect(layer.handle.stack, prefix + mountPrefixOf(layer)));
    }
  }

  return found;
}

function endpoints(): Endpoint[] {
  const router = app as unknown as {
    router?: { stack: unknown[] };
    _router?: { stack: unknown[] };
  };
  return collect(router.router?.stack ?? router._router?.stack ?? []);
}

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Routes exempt from `validate()`, each for a stated reason rather than because
 * adding them here was easier than fixing them.
 *
 *   • `POST /v1/media` takes a raw image body, not JSON — a Zod schema over
 *     bytes would be meaningless. It validates by magic bytes instead, which is
 *     the stronger check (`media.service.ts`).
 */
const VALIDATE_EXEMPT = new Set(['POST /v1/media']);

describe('every mutating route validates its input (§4.4)', () => {
  it('has no route accepting unvalidated input', () => {
    const offenders = endpoints()
      .filter((endpoint) => MUTATING.has(endpoint.method))
      .filter((endpoint) => !VALIDATE_EXEMPT.has(`${endpoint.method} ${endpoint.path}`))
      .filter((endpoint) => !endpoint.handlers.some(isValidationMiddleware))
      .map((endpoint) => `${endpoint.method} ${endpoint.path}`)
      .sort();

    expect(
      offenders,
      `Mutating routes with no validate():\n  ${offenders.join('\n  ')}`,
    ).toStrictEqual([]);
  });
});

/**
 * Trip-scoped routes that resolve access some other way, each deliberately.
 *
 *   • `POST /v1/invites/accept` and `/decline` are the only routes in the
 *     system that run outside a trip guard by design: the caller is not a
 *     member yet, so the invite token IS the authorization. Adversarially
 *     tested in `collab.test.ts`.
 *   • `/p/:slug` routes are the public share surface — authorized by the share
 *     link's own slug, password, and expiry (`sharing.routes.ts`).
 *   • `POST /v1/trips/:tripId/restore` cannot use the guard: the trip is
 *     soft-deleted and `loadTripAccess` filters those out, so the guard would
 *     404 every legitimate restore. `TripsService.restore` re-checks ownership
 *     and returns 404 (not 403) for a stranger's trip. Because this exemption
 *     removes the only automated pressure on that route, `permissions.test.ts`
 *     asserts the service-level check directly.
 */
const GUARD_EXEMPT = [
  /^\/v1\/invites\//,
  /^\/p\//,
  /^\/v1\/trips\/:tripId\/restore$/,
];

describe('every trip-scoped route resolves access through the guard (§8.4)', () => {
  it('has no route reading :tripId without authorizing it', () => {
    const offenders = endpoints()
      .filter((endpoint) => endpoint.path.includes(':tripId'))
      .filter((endpoint) => !GUARD_EXEMPT.some((pattern) => pattern.test(endpoint.path)))
      .filter((endpoint) => !endpoint.handlers.some(isTripAccessGuard))
      .map((endpoint) => `${endpoint.method} ${endpoint.path}`)
      .sort();

    expect(
      offenders,
      `Trip-scoped routes with no access guard:\n  ${offenders.join('\n  ')}`,
    ).toStrictEqual([]);
  });

  it('finds the routes it claims to — the walk is not silently empty', () => {
    const all = endpoints();
    const tripScoped = all.filter((endpoint) => endpoint.path.includes(':tripId'));

    // A stack walk that returns nothing passes every assertion above while
    // proving nothing at all, which is the failure mode of this kind of test.
    expect(all.length).toBeGreaterThan(80);
    expect(tripScoped.length).toBeGreaterThan(50);
    expect(tripScoped.every((endpoint) => endpoint.handlers.length > 0)).toBe(true);
  });
});
