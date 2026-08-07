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

export async function setup(): Promise<void> {
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
