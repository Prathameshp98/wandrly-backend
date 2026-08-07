/**
 * S3-compatible storage driver.
 *
 * Deliberately provider-agnostic rather than "the R2 driver": Cloudflare R2,
 * Backblaze B2, Wasabi and MinIO all speak the same API, so the choice of
 * provider becomes configuration instead of code. Switching costs an endpoint
 * and a pair of keys.
 *
 * This is the one place the codebase takes an SDK for storage, against the note
 * in `supabase.driver.ts`. SigV4 presigning is security-critical — a subtle
 * signing bug either breaks every URL or produces ones that do not expire the
 * way we think — and it is not worth hand-rolling to save a few megabytes.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { loggerFor } from '../logging/logger';
import type { StorageDriver, StoredObject } from './storage.driver';

const log = loggerFor('storage:s3');

export interface S3DriverOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  /**
   * Set when the bucket is served from a public domain (an R2 custom domain, or
   * `r2.dev`). Absent ⇒ every read goes through a signed URL, which is the
   * right default for private media such as receipts.
   */
  readonly publicBaseUrl?: string;
  /** B2 and MinIO need path-style addressing; R2 accepts it. */
  readonly forcePathStyle: boolean;
}

export class S3StorageDriver implements StorageDriver {
  readonly name = 's3';

  private readonly client: S3Client;

  constructor(private readonly options: S3DriverOptions) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      forcePathStyle: options.forcePathStyle,
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );

    return { key, size: body.byteLength, contentType };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );

      if (!response.Body) return null;
      return Buffer.from(await response.Body.transformToByteArray());
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
    } catch (error) {
      // A missing object is already in the desired state.
      if (isNotFound(error)) return;
      log.warn({ key, err: error }, 'storage delete failed');
    }
  }

  async urlFor(key: string, expiresInSeconds: number): Promise<string> {
    if (this.options.publicBaseUrl) {
      return `${this.options.publicBaseUrl.replace(/\/$/, '')}/${key}`;
    }

    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }
}

/**
 * S3 reports a missing object as `NoSuchKey`, but a HEAD-style 404 surfaces as
 * `NotFound` and some implementations only set the HTTP status — so all three
 * are checked rather than trusting one provider's spelling.
 */
function isNotFound(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };

  return (
    candidate?.name === 'NoSuchKey' ||
    candidate?.name === 'NotFound' ||
    candidate?.Code === 'NoSuchKey' ||
    candidate?.$metadata?.httpStatusCode === 404
  );
}
