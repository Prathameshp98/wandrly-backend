/**
 * Google Maps Platform.
 *
 * Better ranking and richer place data than Nominatim, at the cost of a billing
 * account. Opt-in: set GOOGLE_MAPS_API_KEY and it takes over.
 *
 * ── Cost, accurately ──────────────────────────────────────────────────
 * The universal $200/month credit was RETIRED in March 2025. Pricing is now
 * per-SKU monthly free tiers that do not pool:
 *   • Essentials (Geocoding, Static Maps, Dynamic Maps) — 10,000 free/month
 *   • Places Details (Advanced) — $32 per 1,000 beyond its allowance
 *
 * At this project's scale 10,000/month is ample, but a leaked key can generate
 * real charges. Restrict the key by API and referrer, and set a budget alert —
 * see TECHNICAL_DESIGN §11.2.
 */

import { env } from '../config/env';
import { loggerFor } from '../logging/logger';
import type { MapsProvider, Place } from './provider';

const log = loggerFor('maps:google');

interface GooglePlace {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  primaryType?: string;
}

export class GoogleMapsProvider implements MapsProvider {
  readonly name = 'google';
  readonly supportsStaticMaps = true;

  get isConfigured(): boolean {
    return Boolean(env.GOOGLE_MAPS_API_KEY);
  }

  /**
   * Places API (New) Text Search.
   *
   * A `X-Goog-FieldMask` is mandatory and directly determines the billing SKU —
   * requesting only id/name/address/location keeps this on the cheaper tier
   * rather than Places Details (Advanced).
   */
  async search(query: string, limit: number): Promise<Place[]> {
    if (!this.isConfigured) return [];

    try {
      const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY!,
          'X-Goog-FieldMask':
            'places.id,places.displayName,places.formattedAddress,places.location,places.primaryType',
        },
        body: JSON.stringify({ textQuery: query, maxResultCount: limit }),
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        log.warn({ status: response.status }, 'google places search failed');
        return [];
      }

      const body = (await response.json()) as { places?: GooglePlace[] };
      return (body.places ?? []).map((place) => this.normalise(place));
    } catch (error) {
      log.error({ err: error }, 'google places unreachable');
      return [];
    }
  }

  async details(placeId: string): Promise<Place | null> {
    if (!this.isConfigured) return null;

    try {
      const response = await fetch(
        `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
        {
          headers: {
            'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY!,
            'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,primaryType',
          },
          signal: AbortSignal.timeout(8000),
        },
      );

      if (!response.ok) return null;
      return this.normalise((await response.json()) as GooglePlace);
    } catch {
      return null;
    }
  }

  /**
   * Static Maps URL for the PDF export and public page.
   *
   * The key is embedded in the URL, so this must only ever be handed to a
   * server-side renderer — never returned to a browser. Callers are responsible
   * for that; see the export service.
   */
  staticMapUrl(
    pins: { lat: number; lng: number; label?: string }[],
    options: { width: number; height: number },
  ): string | null {
    if (!this.isConfigured || pins.length === 0) return null;

    const url = new URL('https://maps.googleapis.com/maps/api/staticmap');
    url.searchParams.set('size', `${options.width}x${options.height}`);
    url.searchParams.set('scale', '2');
    url.searchParams.set('maptype', 'roadmap');

    // Cap the pin count: the URL has a length limit and a 90-day itinerary
    // would blow past it.
    for (const pin of pins.slice(0, 40)) {
      const label = pin.label ? `label:${pin.label.slice(0, 1)}|` : '';
      url.searchParams.append('markers', `${label}${pin.lat},${pin.lng}`);
    }

    url.searchParams.set('key', env.GOOGLE_MAPS_API_KEY!);
    return url.toString();
  }

  private normalise(place: GooglePlace): Place {
    return {
      placeId: place.id,
      name: place.displayName?.text ?? place.formattedAddress ?? 'Unnamed place',
      address: place.formattedAddress ?? '',
      lat: place.location?.latitude ?? 0,
      lng: place.location?.longitude ?? 0,
      category: place.primaryType ?? null,
    };
  }
}
