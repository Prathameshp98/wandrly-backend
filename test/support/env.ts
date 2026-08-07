/**
 * Test environment bootstrap.
 *
 * Loaded by `setupFiles` BEFORE any application module, because
 * `platform/config/env` parses at import time and exits the process on bad
 * config. Anything that imports the app after this point sees a valid env.
 */

import { config } from 'dotenv';

config({ path: '.env.test', override: true });

// Guardrails, so a stray DATABASE_URL can never point a test run at real data.
if (process.env.NODE_ENV !== 'test') {
  throw new Error('Tests must run with NODE_ENV=test');
}

if (!process.env.DATABASE_URL?.includes('test')) {
  throw new Error(
    `Refusing to run tests against "${process.env.DATABASE_URL}" — ` +
      'the database name must contain "test".',
  );
}
