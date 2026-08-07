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

/**
 * Hand-written files that must run BEFORE the generated schema.
 *
 * Only extensions belong here: `citext` has to exist before any table declares a
 * column of that type. Everything else hand-written runs after, and is
 * discovered rather than listed — see `epilogueFiles`.
 */
const PROLOGUE = ['0001_extensions.sql'];

/** Migration tags Drizzle owns, from its journal. */
function journalTags(): Set<string> {
  const path = join(DRIZZLE_DIR, 'meta', '_journal.json');
  if (!existsSync(path)) return new Set();

  const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries?: { tag: string }[] };
  return new Set((journal.entries ?? []).map((entry) => entry.tag));
}

/**
 * Every hand-written migration that runs after the generated schema, in
 * filename order.
 *
 * Discovered, not hardcoded. An earlier version named `0003` explicitly and
 * nothing else, so `0004_image_providers.sql` and `0005_places.sql` were never
 * applied to a fresh database — the tables simply did not exist, and the first
 * image search in production would have failed on a missing relation. Listing
 * files by hand means every future migration is one forgotten line from the
 * same outcome.
 */
function epilogueFiles(): string[] {
  const owned = journalTags();

  return readdirSync(DRIZZLE_DIR)
    .filter((file) => file.endsWith('.sql'))
    .filter((file) => /^\d{4}_/.test(file))
    .filter((file) => !PROLOGUE.includes(file))
    .filter((file) => !owned.has(file.replace(/\.sql$/, '')))
    .sort();
}

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

async function main(): Promise<void> {
  try {
    // 1. Extensions must exist before any table referencing citext.
    for (const file of PROLOGUE) {
      await runSqlFile(file);
    }

    // 2. Generated schema. `npm run db:generate` produces these from the
    //    Drizzle schema; committed so they are reviewable.
    if (journalTags().size > 0) {
      await migrate(db, { migrationsFolder: DRIZZLE_DIR });
      logger.info('generated schema migrations applied');
    } else {
      logger.warn('no generated migrations found — run `npm run db:generate` first');
    }

    // 3. Invariants, triggers, search indexes, deferred constraints, and any
    //    later hand-written migration. All are written to be idempotent, so
    //    re-running is safe.
    const epilogue = epilogueFiles();
    logger.info({ files: epilogue }, 'applying hand-written migrations');
    for (const file of epilogue) {
      await runSqlFile(file);
    }

    logger.info('migrations complete');
  } catch (error) {
    logger.error({ err: error }, 'migration failed');
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

void main();
