/**
 * OpenAPI coverage.
 *
 * With the frontend undecided, `openapi.json` IS the API contract
 * (TECHNICAL_DESIGN §22). A route that exists but is undocumented is invisible
 * to whatever client eventually arrives — and that drift happened silently
 * across three phases before this test existed.
 *
 * This walks the live Express router stack and fails if any public route is
 * missing from the spec. Documentation can no longer fall behind code.
 */

import { describe, expect, it } from 'vitest';

import { app } from '../support/api';
import { buildOpenApiDocument } from '../../src/contracts/generate-openapi';

interface RouteRef {
  method: string;
  path: string;
}

/**
 * Recover a router's mount prefix.
 *
 * Express 5 replaced the readable `layer.regexp` with opaque matcher FUNCTIONS,
 * so the prefix cannot be parsed out of a source string any more. Instead the
 * matcher is probed with candidate prefixes — which is both simpler and less
 * brittle than depending on internal representations.
 */
const MOUNT_CANDIDATES = ['/v1', '/internal/cron'] as const;

function mountPrefixOf(layer: { matchers?: ((input: string) => unknown)[] }): string {
  const match = layer.matchers?.[0];
  if (typeof match !== 'function') return '';

  // A router mounted at the root matches everything, including our candidates,
  // so rule that out first.
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

/** Express 5 keeps the matcher on `route.path`; nested routers live in `handle.stack`. */
function collectRoutes(stack: unknown[], prefix = ''): RouteRef[] {
  const found: RouteRef[] = [];

  for (const layer of stack as {
    route?: { path: string; methods: Record<string, boolean> };
    handle?: { stack?: unknown[] };
    matchers?: ((input: string) => unknown)[];
  }[]) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        found.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
      }
    } else if (layer.handle?.stack) {
      found.push(...collectRoutes(layer.handle.stack, prefix + mountPrefixOf(layer)));
    }
  }

  return found;
}

/** `/v1/trips/:tripId` → `/v1/trips/{tripId}`. */
const toOpenApiPath = (path: string): string =>
  path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

/**
 * Routes intentionally absent from the public contract.
 *   • /internal/* — shared-secret cron surface (§10.2)
 *   • /health     — infrastructure probe
 *   • /p/*        — server-rendered HTML for humans, not an API
 *   • /docs, /openapi.json — the documentation itself
 */
const UNDOCUMENTED_BY_DESIGN = [
  /^\/internal\//,
  /^\/health$/,
  /^\/p\//,
  /^\/unsubscribe\//,
  /^\/docs/,
  /^\/openapi\.json$/,
];

describe('OpenAPI coverage', () => {
  it('documents every public route', () => {
    const document = buildOpenApiDocument();

    const documented = new Set<string>();
    for (const [path, operations] of Object.entries(document.paths ?? {})) {
      for (const method of Object.keys(operations as object)) {
        documented.add(`${method.toUpperCase()} ${path}`);
      }
    }

    // Express 5 exposes the stack on the router.
    const stack = (app as unknown as { router?: { stack: unknown[] }; _router?: { stack: unknown[] } });
    const routerStack = stack.router?.stack ?? stack._router?.stack ?? [];

    const missing = collectRoutes(routerStack)
      .filter((route) => !UNDOCUMENTED_BY_DESIGN.some((pattern) => pattern.test(route.path)))
      .map((route) => `${route.method} ${toOpenApiPath(route.path)}`)
      .filter((key) => !documented.has(key))
      .sort();

    expect(missing, `Undocumented routes:\n  ${missing.join('\n  ')}`).toStrictEqual([]);
  });

  it('produces a structurally valid document', () => {
    const document = buildOpenApiDocument();
    expect(document.openapi).toMatch(/^3\./);
    expect(document.info.title).toBe('Wandrly API');
    expect(Object.keys(document.paths ?? {}).length).toBeGreaterThan(20);
  });
});
