/**
 * Local disk driver — development and tests only.
 *
 * Keeps the whole media pipeline exercisable offline. Never selected in
 * production; `storage/index.ts` refuses to fall back to it there.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { env } from '../config/env';
import type { StorageDriver, StoredObject } from './storage.driver';

const ROOT = resolve(process.cwd(), '.storage');

export class DiskStorageDriver implements StorageDriver {
  readonly name = 'disk';

  private pathFor(key: string): string {
    // Defensive: a key is server-generated, but never let one escape the root.
    const target = resolve(ROOT, key);
    if (!target.startsWith(ROOT)) throw new Error('storage: path traversal rejected');
    return target;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return { key, size: body.byteLength, contentType };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async urlFor(key: string): Promise<string> {
    // No signing locally — the API streams the bytes.
    return `${env.PUBLIC_BASE_URL}/v1/media/${encodeURIComponent(key)}/content`;
  }
}

export const diskRoot = (): string => join(ROOT);
