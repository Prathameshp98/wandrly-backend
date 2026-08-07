/**
 * OpenStreetMap / Nominatim — the free, keyless default.
 *
 * No API key, no billing account, no credit card. Coverage of named places is
 * genuinely good; ranking is weaker than Google's, which is the trade-off.
 *
 * Nominatim's usage policy is a real constraint, not a suggestion:
 *   • Maximum ~1 request per second.
 *   • A `User-Agent` identifying the application is REQUIRED — requests without
 *     one get blocked.
 *   • Results must be cached.
 * All three are honoured here and in the caching layer above.
 */

import { env } from '../config/env';
import { loggerFor } from '../logging/logger';
import type { MapsProvider, Place } from './provider';

const log = loggerFor('maps:nominatim');

interface NominatimResult {
  place_id: number;
  osm_type?: string;
  osm_id?: number;
  display_name: string;
  name?: string;
  lat: string;
  lon: string;
  type?: string;
  class?: string;
}

/** Serialise calls to respect the 1 req/sec policy. */
let lastRequestAt = 0;
const MIN_INTERVAL_MS = 1100;

async function throttle(): Promise<void> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

export class NominatimProvider implements MapsProvider {
  readonly name = 'osm';
  /** Always available — that is the point of it. */
  readonly isConfigured = true;
  readonly supportsStaticMaps = false;

  private get headers(): Record<string, string> {
    return {
      // Required by the usage policy. An anonymous client gets blocked.
      'User-Agent': `Wandrly/1.0 (${env.PUBLIC_BASE_URL})`,
      Accept: 'application/json',
    };
  }

  async search(query: string, limit: number): Promise<Place[]> {
    await throttle();

    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('addressdetails', '0');

    try {
      const response = await fetch(url, { headers: this.headers, signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        log.warn({ status: response.status }, 'nominatim search failed');
        return [];
      }

      const body = (await response.json()) as NominatimResult[];
      return body.map((row) => this.normalise(row));
    } catch (error) {
      // A geocoder outage must not break trip creation (FR-NFR-REL-04).
      log.error({ err: error }, 'nominatim unreachable');
      return [];
    }
  }

  async details(placeId: string): Promise<Place | null> {
    await throttle();

    const url = new URL('https://nominatim.openstreetmap.org/lookup');
    // Nominatim looks up by OSM type+id, which is what we encode in placeId.
    url.searchParams.set('osm_ids', placeId);
    url.searchParams.set('format', 'jsonv2');

    try {
      const response = await fetch(url, { headers: this.headers, signal: AbortSignal.timeout(8000) });
      if (!response.ok) return null;

      const body = (await response.json()) as NominatimResult[];
      return body[0] ? this.normalise(body[0]) : null;
    } catch {
      return null;
    }
  }

  /** OSM has no first-party static image service. */
  staticMapUrl(): string | null {
    return null;
  }

  private normalise(row: NominatimResult): Place {
    const prefix = row.osm_type?.charAt(0).toUpperCase();
    return {
      // Prefer the OSM type+id form, which `lookup` can resolve later.
      placeId: prefix && row.osm_id ? `${prefix}${row.osm_id}` : String(row.place_id),
      name: row.name?.trim() || row.display_name.split(',')[0]!.trim(),
      address: row.display_name,
      lat: Number(row.lat),
      lng: Number(row.lon),
      category: row.type ?? row.class ?? null,
    };
  }
}
