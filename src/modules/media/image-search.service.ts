/**
 * Provider-backed image search and import.
 *
 * TECHNICAL_DESIGN §11.1. Two things this layer is responsible for:
 *
 *   1. **Staying inside the rate limit.** Pexels allows 200 requests/hour and a
 *      search-as-you-type field would burn that in minutes, so every query is
 *      cached in Postgres for an hour.
 *   2. **Obeying each provider's attachment mode.** Pexels permits self-hosting
 *      (IMPORT); Unsplash would require hotlinking (REFERENCE). The mode is a
 *      property of the provider, never a caller's choice.
 */

import { and, eq, sql } from 'drizzle-orm';

import { limits } from '../../platform/config/env';
import { newId } from '../../platform/crypto/index';
import { db } from '../../platform/db/index';
import { imageSearchCache, mediaAssets } from '../../platform/db/schema/index';
import { DomainRuleError, LimitExceededError, NotFoundError } from '../../platform/errors/AppError';
import {
  configuredProviders,
  defaultProvider,
  providerByName,
  type ImageProvider,
  type ProviderPhoto,
  type SearchResult,
} from '../../platform/images/index';
import { storage } from '../../platform/storage/index';
import { loggerFor } from '../../platform/logging/logger';
import { inspect } from './image';

const log = loggerFor('image-search');

const CACHE_TTL_MS = 60 * 60 * 1000;
/** Guard against a provider serving something enormous. */
const MAX_IMPORT_BYTES = 15 * 1024 * 1024;

export interface ImportedImage {
  id: string;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  tone: string | null;
  /** Always present for provider images — attribution is a licence obligation. */
  attribution: string;
  attributionUrl: string | null;
  provider: string;
  /** Set only in REFERENCE mode, where we may not self-host the bytes. */
  remoteUrl: string | null;
}

export class ImageSearchService {
  /** Which sources the picker can offer, given what is configured. */
  sources() {
    return configuredProviders().map((provider) => ({
      name: provider.name,
      attributionLabel: provider.attributionLabel,
      attachMode: provider.attachMode,
    }));
  }

  async search(
    providerName: string | undefined,
    query: string,
    page: number,
    perPage: number,
  ): Promise<SearchResult & { provider: string; attributionLabel: string }> {
    const provider = this.resolve(providerName);
    const normalisedQuery = query.trim().toLowerCase();

    const cached = await this.readCache(provider.name, normalisedQuery, page);
    if (cached) {
      return { ...cached, provider: provider.name, attributionLabel: provider.attributionLabel };
    }

    const result = await provider.search(query, page, perPage);
    await this.writeCache(provider.name, normalisedQuery, page, result);

    return { ...result, provider: provider.name, attributionLabel: provider.attributionLabel };
  }

  /**
   * Attach a provider photo to the user's library.
   *
   * IMPORT mode downloads the bytes into our storage. REFERENCE mode records
   * the CDN URL and downloads nothing, because the provider forbids caching.
   */
  async attach(
    userId: string,
    providerName: string | undefined,
    photoId: string,
  ): Promise<ImportedImage> {
    const provider = this.resolve(providerName);

    // The picker is paginated and cached, so the chosen photo is almost always
    // already local — no extra provider call to re-fetch one id.
    const photo = await this.findCachedPhoto(provider.name, photoId);
    if (!photo) {
      throw new NotFoundError('Photo (search for it again, then pick it)');
    }

    const existing = await db
      .select()
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.ownerId, userId),
          eq(mediaAssets.provider, provider.name),
          eq(mediaAssets.providerPhotoId, photoId),
        ),
      )
      .limit(1);

    // Picking the same photo twice is idempotent, not a duplicate.
    if (existing[0]) return this.toImported(existing[0]);

    const attribution = `Photo by ${photo.photographer} on ${
      provider.name.charAt(0).toUpperCase() + provider.name.slice(1)
    }`;

    const id = newId();

    if (provider.attachMode === 'REFERENCE') {
      await db.insert(mediaAssets).values({
        id,
        ownerId: userId,
        source: 'PROVIDER',
        provider: provider.name,
        providerPhotoId: photoId,
        remoteUrl: photo.url,
        externalRef: photo.sourceUrl,
        mimeType: 'image/jpeg',
        width: photo.width,
        height: photo.height,
        blurhash: photo.tone,
        altText: photo.description,
        attribution,
        attributionUrl: photo.photographerUrl,
        state: 'READY',
      });
    } else {
      const { body, mimeType } = await this.download(photo.url);

      await this.assertQuota(userId, body.byteLength);

      const key = `${userId}/${id}`;
      await storage.put(key, body, mimeType);

      await db.insert(mediaAssets).values({
        id,
        ownerId: userId,
        storageKey: key,
        source: 'PROVIDER',
        provider: provider.name,
        providerPhotoId: photoId,
        externalRef: photo.sourceUrl,
        mimeType,
        byteSize: body.byteLength,
        width: photo.width,
        height: photo.height,
        blurhash: photo.tone,
        altText: photo.description,
        attribution,
        attributionUrl: photo.photographerUrl,
        state: 'READY',
      });
    }

    // Unsplash requires this ping; Pexels does not. The provider decides.
    await provider.trackUse(photo).catch((error: unknown) => {
      log.warn({ err: error, provider: provider.name }, 'provider use-tracking failed');
    });

    const [created] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).limit(1);
    return this.toImported(created!);
  }

  // ── Internals ─────────────────────────────────────────────────────

  private resolve(name: string | undefined): ImageProvider {
    const provider = name ? providerByName(name) : defaultProvider();
    if (!provider) throw new DomainRuleError(`Unknown image source: ${name}`);
    if (!provider.isConfigured) {
      throw new DomainRuleError(
        `Image search via ${provider.name} is not configured on this server`,
      );
    }
    return provider;
  }

  private async download(url: string): Promise<{ body: Buffer; mimeType: string }> {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      throw new DomainRuleError('That image could not be fetched from the provider');
    }

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_IMPORT_BYTES) {
      throw new DomainRuleError('That image is too large to import');
    }

    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > MAX_IMPORT_BYTES) {
      throw new DomainRuleError('That image is too large to import');
    }

    // Same rule as user uploads: identify by content, never by what the remote
    // server claims (FR-NFR-SEC-05). A provider is still an untrusted source.
    const info = inspect(body);
    if (!info) throw new DomainRuleError('The provider returned something that is not an image');

    return { body, mimeType: info.mimeType };
  }

  private async assertQuota(userId: string, incoming: number): Promise<void> {
    const [row] = await db
      .select({ used: sql<string>`coalesce(sum(${mediaAssets.byteSize}), 0)::text` })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.ownerId, userId), eq(mediaAssets.state, 'READY')));

    if (Number(row?.used ?? '0') + incoming > limits.mediaBytesPerUser) {
      throw new LimitExceededError('bytes of media', limits.mediaBytesPerUser);
    }
  }

  private async readCache(
    provider: string,
    query: string,
    page: number,
  ): Promise<SearchResult | null> {
    const rows = await db
      .select()
      .from(imageSearchCache)
      .where(
        and(
          eq(imageSearchCache.provider, provider),
          eq(imageSearchCache.query, query),
          eq(imageSearchCache.page, page),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    if (Date.now() - row.fetchedAt.getTime() > CACHE_TTL_MS) return null;

    return row.results as SearchResult;
  }

  private async writeCache(
    provider: string,
    query: string,
    page: number,
    result: SearchResult,
  ): Promise<void> {
    // Never cache an empty result — that would pin a rate-limit failure or an
    // outage in place for an hour.
    if (result.photos.length === 0) return;

    await db
      .insert(imageSearchCache)
      .values({ provider, query, page, results: result as never })
      .onConflictDoUpdate({
        target: [imageSearchCache.provider, imageSearchCache.query, imageSearchCache.page],
        set: { results: result as never, fetchedAt: new Date() },
      });
  }

  /** Find a photo in any cached page for this provider. */
  private async findCachedPhoto(
    provider: string,
    photoId: string,
  ): Promise<ProviderPhoto | null> {
    const rows = await db
      .select({ results: imageSearchCache.results })
      .from(imageSearchCache)
      .where(eq(imageSearchCache.provider, provider))
      .limit(200);

    for (const row of rows) {
      const result = row.results as SearchResult;
      const match = result.photos?.find((photo) => photo.id === photoId);
      if (match) return match;
    }

    return null;
  }

  private toImported(asset: typeof mediaAssets.$inferSelect): ImportedImage {
    return {
      id: asset.id,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
      tone: asset.blurhash,
      attribution: asset.attribution ?? '',
      attributionUrl: asset.attributionUrl,
      provider: asset.provider ?? 'unknown',
      remoteUrl: asset.remoteUrl,
    };
  }
}

export const imageSearchService = new ImageSearchService();
