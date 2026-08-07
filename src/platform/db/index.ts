/**
 * Database access.
 *
 * Exposes a single `Db` type that is either the pool-backed client or an active
 * transaction. Every repository accepts a `Db`, which is what makes the Unit of
 * Work pattern in `withTransaction` work without repositories knowing whether
 * they are inside one — Dependency Inversion applied to the data layer.
 */

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { env, isProduction } from '../config/env';
import { loggerFor } from '../logging/logger';
import * as schema from './schema/index';

const log = loggerFor('db');

/**
 * Postgres returns int8 (BIGINT) as a string by default to avoid precision
 * loss. Drizzle's `mode: 'bigint'` columns handle the conversion, so the
 * default parser is left alone deliberately — overriding it to Number here
 * would silently break money arithmetic above 2^53.
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // A query that cannot get a connection should surface as an error, not an
  // indefinite stall. This turns pool starvation into a diagnosable failure.
  statement_timeout: 15_000,
  // Managed Postgres (Supabase) requires TLS; local Docker does not.
  ssl: isProduction ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (error) => {
  log.error({ err: error }, 'idle postgres client error');
});

export const db: NodePgDatabase<typeof schema> = drizzle(pool, {
  schema,
  logger: env.LOG_LEVEL === 'trace',
});

/**
 * Either the root client or a transaction handle.
 *
 * Services and repositories depend on this type, never on the concrete pool, so
 * the same code runs inside and outside a transaction.
 */
export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;

/**
 * Unit of Work.
 *
 * Everything a mutation touches — including its activity_events audit row —
 * commits or rolls back together. Realtime broadcasts are deliberately NOT
 * emitted inside here; see `platform/realtime` and §7.
 */
export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => fn(tx));
}

/** Liveness probe used by `/health` and by Koyeb's health check. */
export async function checkDatabase(): Promise<boolean> {
  try {
    const client = await pool.connect();
    try {
      await client.query('select 1');
      return true;
    } finally {
      client.release();
    }
  } catch (error) {
    log.error({ err: error }, 'database health check failed');
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
  log.info('postgres pool closed');
}

export { schema };
