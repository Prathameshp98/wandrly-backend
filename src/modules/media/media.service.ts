/**
 * Media uploads.
 *
 * TECHNICAL_DESIGN §11 specified presigned direct-to-storage uploads so bytes
 * never transit the API. This implementation deliberately routes them THROUGH
 * the API instead, for two reasons:
 *
 *   1. Magic-byte validation and EXIF stripping require the bytes anyway.
 *      Presigning would put an unvalidated, GPS-bearing file in the bucket and
 *      only sanitise it afterwards — a window that does not need to exist.
 *   2. At ≤30 users a 10 MB cap through a 512 MB container is a non-issue.
 *
 * Revisit if upload volume ever makes the API the bottleneck; the storage
 * driver interface already supports either shape.
 */

import { and, desc, eq, sql } from 'drizzle-orm';

import { limits } from '../../platform/config/env';
import { newId } from '../../platform/crypto/index';
import { db } from '../../platform/db/index';
import { mediaAssets } from '../../platform/db/schema/index';
import { DomainRuleError, LimitExceededError, NotFoundError } from '../../platform/errors/AppError';
import { storage } from '../../platform/storage/index';
import { loggerFor } from '../../platform/logging/logger';
import { inspect, placeholderTone, stripExif } from './image';

const log = loggerFor('media');

/** FR-SEC-03. GIF is accepted on upload but not advertised. */
const ALLOWED = new Set(['jpeg', 'png', 'webp', 'heic']);

export interface UploadResult {
  id: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  byteSize: number;
  tone: string;
  altText: string | null;
  /**
   * FR-MEDIA-03 is a licence obligation, so these are part of EVERY
   * representation — explicitly null for a device upload rather than omitted.
   * "Field missing" and "no credit required" must not look alike to a client
   * deciding whether it has to render a photographer's name.
   */
  provider: string | null;
  attribution: string | null;
  attributionUrl: string | null;
}

export class MediaService {
  async upload(
    userId: string,
    buffer: Buffer,
    options: { altText?: string } = {},
  ): Promise<UploadResult> {
    if (buffer.byteLength === 0) {
      throw new DomainRuleError('The uploaded file is empty');
    }

    if (buffer.byteLength > limits.uploadBytes) {
      throw new LimitExceededError(
        // eslint-disable-next-line no-restricted-syntax -- megabytes, not money
        `bytes per upload (${Math.round(limits.uploadBytes / 1024 / 1024)} MB)`,
        limits.uploadBytes,
      );
    }

    // Identify by content, never by the declared type (FR-NFR-SEC-05).
    const info = inspect(buffer);
    if (!info || !ALLOWED.has(info.format)) {
      throw new DomainRuleError(
        'That file is not a supported image. JPEG, PNG, WebP, and HEIC are accepted.',
      );
    }

    await this.assertQuota(userId, buffer.byteLength);

    // Strip EXIF before anything is persisted, so GPS never reaches storage.
    const sanitised = stripExif(buffer, info.format);

    const id = newId();
    const key = `${userId}/${id}`;

    await storage.put(key, sanitised, info.mimeType);

    await db.insert(mediaAssets).values({
      id,
      ownerId: userId,
      storageKey: key,
      source: 'UPLOAD',
      mimeType: info.mimeType,
      byteSize: sanitised.byteLength,
      width: info.width,
      height: info.height,
      blurhash: placeholderTone(sanitised),
      altText: options.altText ?? null,
      state: 'READY',
    });

    log.info({ id, format: info.format, bytes: sanitised.byteLength }, 'media stored');

    return {
      id,
      mimeType: info.mimeType,
      width: info.width,
      height: info.height,
      byteSize: sanitised.byteLength,
      tone: placeholderTone(sanitised),
      altText: options.altText ?? null,
      // FR-MEDIA-03 is a licence obligation, so attribution is part of EVERY
      // representation — explicitly null for a device upload rather than
      // omitted. A client cannot render a credit it cannot see the absence of,
      // and "field missing" and "no credit required" must not look alike.
      provider: null,
      attribution: null,
      attributionUrl: null,
    };
  }

  /** FR-NFR-SCALE-04, scaled down for the free tier (§19). */
  private async assertQuota(userId: string, incoming: number): Promise<void> {
    const [row] = await db
      .select({ used: sql<string>`coalesce(sum(${mediaAssets.byteSize}), 0)::text` })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.ownerId, userId), eq(mediaAssets.state, 'READY')));

    const used = Number(row?.used ?? '0');
    if (used + incoming > limits.mediaBytesPerUser) {
      throw new LimitExceededError(
        // eslint-disable-next-line no-restricted-syntax -- megabytes, not money
        `bytes of media (${Math.round(limits.mediaBytesPerUser / 1024 / 1024)} MB)`,
        limits.mediaBytesPerUser,
      );
    }
  }

  async findById(id: string) {
    const rows = await db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).limit(1);
    const asset = rows[0];
    if (!asset) throw new NotFoundError('Media');
    return asset;
  }

  /**
   * Raw bytes.
   *
   * Authorization is the caller's problem, not this method's — see the route,
   * which restricts to the owner or a co-member of a trip the asset appears in.
   */
  async content(id: string): Promise<{ body: Buffer; mimeType: string }> {
    const asset = await this.findById(id);
    if (!asset.storageKey) throw new NotFoundError('Media');

    const body = await storage.get(asset.storageKey);
    if (!body) throw new NotFoundError('Media');

    return { body, mimeType: asset.mimeType ?? 'application/octet-stream' };
  }

  async urlFor(id: string, expiresInSeconds = 3600): Promise<string> {
    const asset = await this.findById(id);
    if (!asset.storageKey) throw new NotFoundError('Media');
    return storage.urlFor(asset.storageKey, expiresInSeconds);
  }

  async listForUser(userId: string, limit = 50) {
    return db
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.ownerId, userId), eq(mediaAssets.state, 'READY')))
      .orderBy(desc(mediaAssets.createdAt))
      .limit(limit);
  }

  async setAltText(userId: string, id: string, altText: string | null) {
    const asset = await this.findById(id);
    if (asset.ownerId !== userId) throw new NotFoundError('Media');

    const [updated] = await db
      .update(mediaAssets)
      .set({ altText })
      .where(eq(mediaAssets.id, id))
      .returning();

    return updated!;
  }

  async remove(userId: string, id: string): Promise<void> {
    const asset = await this.findById(id);
    // 404 rather than 403 — never confirm someone else's asset exists.
    if (asset.ownerId !== userId) throw new NotFoundError('Media');

    if (asset.storageKey) await storage.delete(asset.storageKey);
    await db.delete(mediaAssets).where(eq(mediaAssets.id, id));
  }

  async usage(userId: string) {
    const [row] = await db
      .select({
        used: sql<string>`coalesce(sum(${mediaAssets.byteSize}), 0)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.ownerId, userId), eq(mediaAssets.state, 'READY')));

    return {
      usedBytes: Number(row?.used ?? '0'),
      quotaBytes: limits.mediaBytesPerUser,
      assetCount: row?.count ?? 0,
    };
  }
}

export const mediaService = new MediaService();
