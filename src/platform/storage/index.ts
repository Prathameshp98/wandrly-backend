/**
 * Storage driver selection.
 *
 * Production requires real credentials; falling back to disk there would put
 * user uploads on an ephemeral container filesystem that vanishes on redeploy.
 */

import { env, isProduction } from '../config/env';
import { loggerFor } from '../logging/logger';
import { DiskStorageDriver } from './disk.driver';
import { SupabaseStorageDriver } from './supabase.driver';
import type { StorageDriver } from './storage.driver';

const log = loggerFor('storage');

function select(): StorageDriver {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    return new SupabaseStorageDriver(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_KEY,
      env.STORAGE_BUCKET,
    );
  }

  if (isProduction) {
    // Loud, immediate failure beats silently writing to a disk that disappears.
    throw new Error(
      'Production requires SUPABASE_URL and SUPABASE_SERVICE_KEY for media storage',
    );
  }

  log.info('using local disk storage (no Supabase credentials configured)');
  return new DiskStorageDriver();
}

export const storage: StorageDriver = select();
export type { StorageDriver, StoredObject } from './storage.driver';
