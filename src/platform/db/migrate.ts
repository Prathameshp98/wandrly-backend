/**
 * Migration runner.
 *
 * TECHNICAL_DESIGN §15.2: migrations run as a SEPARATE deploy step, never on
 * boot. Running them in the app's startup path means a failed migration takes
 * the service down, and a second instance could run them twice.
 *
 * Order (§5.7): hand-written prologue → generated schema → hand-written epilogue.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';

import { closeDatabase, db } from './index';
import { logger } from '../logging/logger';

const DRIZZLE_DIR = 'drizzle';

/** Hand-written SQL files, applied in filename order around the generated ones. */
async function runSqlFile(filename: string): Promise<void> {
  const path = join(DRIZZLE_DIR, filename);
  if (!existsSync(path)) {
    logger.warn({ filename }, 'sql migration not found; skipping');
    return;
  }

  const contents = readFileSync(path, 'utf8');
  logger.info({ filename }, 'applying sql migration');
  await db.execute(sql.raw(contents));
}

function hasGeneratedMigrations(): boolean {
  if (!existsSync(DRIZZLE_DIR)) return false;
  return readdirSync(DRIZZLE_DIR).some(
    (file) => file.endsWith('.sql') && /^\d{4}_/.test(file) && !file.includes('extensions') && !file.includes('invariants'),
  );
}

async function main(): Promise<void> {
  try {
    // 1. Extensions must exist before any table referencing citext.
    await runSqlFile('0001_extensions.sql');

    // 2. Generated schema. `npm run db:generate` produces these from the
    //    Drizzle schema; committed so they are reviewable.
    if (hasGeneratedMigrations()) {
      await migrate(db, { migrationsFolder: DRIZZLE_DIR });
      logger.info('generated schema migrations applied');
    } else {
      logger.warn(
        'no generated migrations found — run `npm run db:generate` first',
      );
    }

    // 3. Invariants, triggers, search indexes, deferred constraints.
    await runSqlFile('0003_ledger_invariants.sql');

    logger.info('migrations complete');
  } catch (error) {
    logger.error({ err: error }, 'migration failed');
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

void main();
