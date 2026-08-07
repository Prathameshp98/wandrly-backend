/**
 * Suite-wide setup and teardown.
 *
 * Deliberately does NOT truncate. Tests isolate by unique data (see `db.ts`),
 * and any global mutation is a shared-state hazard across files — which is
 * exactly what caused rows to vanish mid-test.
 *
 * Closing the pool must happen exactly once, after every file finishes: a
 * per-file `afterAll(closeDatabase)` is a race, because the first file to
 * finish closes the pool out from under the rest.
 */

import { config } from 'dotenv';

/**
 * `globalSetup` runs in the main Vitest process, where `setupFiles` have NOT
 * run — so `.env.test` is unloaded and the guards in `support/env.ts` are not
 * in force. Without this, the TRUNCATE below targets whatever `DATABASE_URL`
 * happens to be ambient: a real `.env` pointing at Supabase truncates
 * production. Load the test env and re-assert the guard here, in the process
 * that actually issues the statement.
 */
function requireTestDatabase(): void {
  config({ path: '.env.test', override: true });

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set — refusing to run tests');

  const database = new URL(url).pathname.replace(/^\//, '');
  if (!/test/i.test(database)) {
    throw new Error(
      `Refusing to TRUNCATE database "${database}" — its name must contain "test". ` +
        'Check .env.test, and that no ambient DATABASE_URL is overriding it.',
    );
  }
}

export async function setup(): Promise<void> {
  requireTestDatabase();
  const { truncateAll, seedFxRates } = await import('./db');
  // One clean slate before anything runs, so a previous run's data does not
  // accumulate forever. Nothing truncates after this point.
  await truncateAll();
  await seedFxRates();
}

export async function teardown(): Promise<void> {
  const { closeDatabase } = await import('../../src/platform/db/index');
  await closeDatabase();
}
