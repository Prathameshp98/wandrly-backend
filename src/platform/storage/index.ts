/**
 * Storage driver selection.
 *
 * Production requires real credentials; falling back to disk there would put
 * user uploads on an ephemeral container filesystem that vanishes on redeploy.
 */

import { env, isProduction } from '../config/env';
import { loggerFor } from '../logging/logger';
import { DiskStorageDriver } from './disk.driver';
import { S3StorageDriver } from './s3.driver';
import { SupabaseStorageDriver } from './supabase.driver';
import type { StorageDriver } from './storage.driver';

const log = loggerFor('storage');

/**
 * S3 first, Supabase second, disk last.
 *
 * S3-compatible providers win when configured because Supabase's free tier caps
 * storage at 1 GB and egress at 5 GB — for an app whose main artefact is trip
 * photos, egress is the binding constraint, and R2's is free.
 */
function select(): StorageDriver {
  if (env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) {
    log.info({ endpoint: env.S3_ENDPOINT, bucket: env.STORAGE_BUCKET }, 'using S3 storage');
    return new S3StorageDriver({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      bucket: env.STORAGE_BUCKET,
      publicBaseUrl: env.S3_PUBLIC_BASE_URL,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    });
  }

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
      'Production requires object storage: set the S3_* variables (R2, B2) ' +
        'or SUPABASE_URL and SUPABASE_SERVICE_KEY',
    );
  }

  log.info('using local disk storage (no object-storage credentials configured)');
  return new DiskStorageDriver();
}

export const storage: StorageDriver = select();
export type { StorageDriver, StoredObject } from './storage.driver';
