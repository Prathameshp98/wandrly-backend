/**
 * Pexels image provider.
 *
 * Chosen over Unsplash and Pixabay after comparing terms:
 *
 *   • 200 req/hour and 20,000/month with NO approval process. Unsplash is
 *     50/hour until a manual review (screenshots, ~48h) raises it to 1,000.
 *   • Self-hosting is permitted, which the existing media pipeline already
 *     does — Unsplash forbids it outright.
 *   • Strong, curated travel imagery; close to Unsplash on quality and well
 *     ahead of Pixabay on consistency.
 *
 * Attribution is MANDATORY under the Pexels API terms: a prominent link to
 * Pexels plus a photographer credit. That obligation is why `attribution` and
 * `attribution_url` are non-optional on any provider-sourced asset.
 */

import { env } from '../config/env';
import { loggerFor } from '../logging/logger';
import type { ImageProvider, ProviderPhoto, SearchResult } from './provider';

const log = loggerFor('images:pexels');

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer: string;
  photographer_url: string;
  avg_color: string | null;
  alt: string | null;
  src: { original: string; large2x: string; large: string; medium: string; small: string };
}

interface PexelsSearchResponse {
  photos: PexelsPhoto[];
  page: number;
  per_page: number;
  total_results: number;
}

export class PexelsProvider implements ImageProvider {
  readonly name = 'pexels';
  /** Pexels permits self-hosting, so imported bytes go through our pipeline. */
  readonly attachMode = 'IMPORT' as const;
  readonly attributionLabel = 'Photos provided by Pexels';

  get isConfigured(): boolean {
    return Boolean(env.PEXELS_API_KEY);
  }

  async search(query: string, page: number, perPage: number): Promise<SearchResult> {
    if (!this.isConfigured) {
      // Degrade rather than fail: the picker shows an empty state and uploads
      // still work (FR-NFR-REL-04).
      log.info('PEXELS_API_KEY not configured — image search unavailable');
      return { photos: [], page, totalPages: 0 };
    }

    const url = new URL('https://api.pexels.com/v1/search');
    url.searchParams.set('query', query);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(perPage));
    // Landscape suits itinerary cards and block thumbnails.
    url.searchParams.set('orientation', 'landscape');

    const response = await fetch(url, {
      headers: { Authorization: env.PEXELS_API_KEY! },
      signal: AbortSignal.timeout(8000),
    });

    if (response.status === 429) {
      log.warn('Pexels rate limit reached');
      return { photos: [], page, totalPages: 0 };
    }

    if (!response.ok) {
      log.error({ status: response.status }, 'Pexels search failed');
      return { photos: [], page, totalPages: 0 };
    }

    const body = (await response.json()) as PexelsSearchResponse;

    return {
      photos: body.photos.map((photo) => this.normalise(photo)),
      page: body.page,
      totalPages: Math.ceil(body.total_results / Math.max(body.per_page, 1)),
    };
  }

  private normalise(photo: PexelsPhoto): ProviderPhoto {
    return {
      id: String(photo.id),
      description: photo.alt?.trim() || `Photo by ${photo.photographer}`,
      // `large2x` is ample for a full-bleed cover without pulling a 20 MB original.
      url: photo.src.large2x,
      thumbUrl: photo.src.medium,
      width: photo.width,
      height: photo.height,
      tone: photo.avg_color,
      photographer: photo.photographer,
      photographerUrl: photo.photographer_url,
      sourceUrl: photo.url,
    };
  }

  /** Pexels has no download-tracking requirement, unlike Unsplash. */
  async trackUse(): Promise<void> {
    // Intentionally empty.
  }
}
