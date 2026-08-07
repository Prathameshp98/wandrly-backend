/**
 * Supabase Storage driver.
 *
 * Uses the REST API directly rather than the JS SDK — three fetch calls do not
 * justify a dependency, and it keeps the container small (TECHNICAL_DESIGN
 * §15.2 targets a sub-150 MB image).
 */

import { env } from '../config/env';
import { loggerFor } from '../logging/logger';
import type { StorageDriver, StoredObject } from './storage.driver';

const log = loggerFor('storage:supabase');

export class SupabaseStorageDriver implements StorageDriver {
  readonly name = 'supabase';

  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly bucket: string,
  ) {}

  private endpoint(path: string): string {
    return `${this.url}/storage/v1/${path}`;
  }

  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.serviceKey}` };
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    const response = await fetch(this.endpoint(`object/${this.bucket}/${key}`), {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': contentType, 'x-upsert': 'true' },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`storage put failed (${response.status}): ${await response.text()}`);
    }

    return { key, size: body.byteLength, contentType };
  }

  async get(key: string): Promise<Buffer | null> {
    const response = await fetch(this.endpoint(`object/${this.bucket}/${key}`), {
      headers: this.headers,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const response = await fetch(this.endpoint(`object/${this.bucket}/${key}`), {
      method: 'DELETE',
      headers: this.headers,
      signal: AbortSignal.timeout(15_000),
    });

    // A missing object is already in the desired state.
    if (!response.ok && response.status !== 404) {
      log.warn({ key, status: response.status }, 'storage delete failed');
    }
  }

  /** Short-lived signed URL — media is private by default (receipts especially). */
  async urlFor(key: string, expiresInSeconds: number): Promise<string> {
    const response = await fetch(this.endpoint(`object/sign/${this.bucket}/${key}`), {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: expiresInSeconds }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`storage sign failed (${response.status})`);
    }

    const { signedURL } = (await response.json()) as { signedURL: string };
    return `${this.url}/storage/v1${signedURL}`;
  }
}

void env;
