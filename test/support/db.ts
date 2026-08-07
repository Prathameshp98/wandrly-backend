/**
 * Database isolation for API tests.
 *
 * Per-test transaction rollback is NOT usable here: an HTTP request runs through
 * the app's own pool connection and opens its own transactions, so a wrapping
 * transaction in the test would be invisible to it. Truncation is the correct
 * tool for HTTP-level tests, and at this data volume it costs ~2ms.
 */

import { sql } from 'drizzle-orm';

import { drainBackground } from '../../src/platform/background';
import { closeDatabase, db } from '../../src/platform/db/index';

/**
 * Tables in no particular order — CASCADE handles dependencies, and RESTART
 * IDENTITY resets the `activity_events` bigserial so ids stay small and
 * readable in failure output.
 */
const TABLES = [
  'activity_events',
  'notifications',
  'suggestions',
  'comments',
  'share_links',
  'invites',
  'settlements',
  'expense_shares',
  'expense_payments',
  'expenses',
  'trip_participants',
  'packing_items',
  'trip_notes',
  'blocks',
  'days',
  'variants',
  'trip_members',
  'trip_user_state',
  'trips',
  'folders',
  'media_assets',
  'user_preferences',
  'idempotency_keys',
  'users',
  'fx_rates',
] as const;

/**
 * Isolation strategy: UNIQUE DATA, not a clean table.
 *
 * Truncating in `beforeEach` was the obvious approach and it was wrong. With a
 * single shared database, one file's truncate can land while another file's
 * test is mid-flight, deleting rows that test had just created. It surfaced as
 * a ~30% chance of some unrelated assertion getting a 404 for a row it had
 * provably just used.
 *
 * Every factory mints a fresh UUID and every query is scoped by user or trip,
 * so tests are already isolated from each other by construction. A clean table
 * was never what they needed.
 *
 * This is now a NO-OP kept for call-site compatibility; the suite truncates
 * exactly once, at startup.
 */
export async function resetDatabase(): Promise<void> {
  await drainBackground();
}

/** Truncate everything. Called once per suite, never between tests. */
export async function truncateAll(): Promise<void> {
  await drainBackground();
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`),
  );
}

/** Seed the FX rates the ledger needs for non-base-currency expenses. */
export async function seedFxRates(): Promise<void> {
  await db.execute(sql`
    INSERT INTO fx_rates (base_currency, quote_currency, rate, as_of) VALUES
      ('JPY', 'INR', 0.58000000, '2026-05-18'),
      ('USD', 'INR', 83.00000000, '2026-05-18'),
      ('EUR', 'INR', 90.00000000, '2026-05-18'),
      ('INR', 'JPY', 1.72413793, '2026-05-18')
    ON CONFLICT DO NOTHING
  `);
}

export async function closeTestDatabase(): Promise<void> {
  await closeDatabase();
}

export { db };
