/**
 * Place search and the trip map.
 *
 * TECHNICAL_DESIGN §11.2. The backend resolves text to coordinates and hands
 * the client a set of pins; drawing the map itself is the client's job, with
 * free OpenStreetMap tiles and MapLibre or Leaflet.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { db } from '../../platform/db/index';
import { blocks, days, placeSearchCache, trips, variants } from '../../platform/db/schema/index';
import { NotFoundError } from '../../platform/errors/AppError';
import { maps, type Place } from '../../platform/maps/index';
import type { TripAccess } from '../../platform/policy/index';

/**
 * Cached for a week. Place coordinates effectively never move, and both
 * providers want this: Google bills per request, Nominatim asks clients to
 * cache and stay under ~1 req/sec.
 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface MapPin {
  blockId: string;
  dayId: string;
  dayNumber: number;
  blockType: string;
  title: string;
  name: string;
  lat: number;
  lng: number;
}

export class PlacesService {
  get providerName(): string {
    return maps.name;
  }

  async search(query: string, limit: number): Promise<Place[]> {
    const normalised = query.trim().toLowerCase();

    const cached = await this.readCache(normalised);
    if (cached) return cached;

    const results = await maps.search(query, limit);

    // Never cache an empty result: that would pin a provider outage or a
    // rate-limit block in place for a week.
    if (results.length > 0) await this.writeCache(normalised, results);

    return results;
  }

  async details(placeId: string): Promise<Place> {
    const place = await maps.details(placeId);
    if (!place) throw new NotFoundError('Place');
    return place;
  }

  /**
   * FR-PANEL-04/05 — every located block on one map.
   *
   * Returns pins with their day number so the client can colour markers by day
   * and draw a route line, rather than the prototype's one-embed-at-a-time.
   */
  async tripMap(access: TripAccess, variantId?: string): Promise<{
    pins: MapPin[];
    center: { lat: number; lng: number } | null;
    bounds: { north: number; south: number; east: number; west: number } | null;
  }> {
    const [trip] = await db
      .select({ mainVariantId: trips.mainVariantId })
      .from(trips)
      .where(eq(trips.id, access.tripId))
      .limit(1);

    const targetVariant = variantId ?? trip?.mainVariantId;
    if (!targetVariant) return { pins: [], center: null, bounds: null };

    const rows = await db
      .select({
        blockId: blocks.id,
        dayId: days.id,
        dayNumber: days.dayNumber,
        blockType: blocks.type,
        title: blocks.title,
        sections: blocks.sections,
      })
      .from(blocks)
      .innerJoin(days, eq(days.id, blocks.dayId))
      .innerJoin(variants, eq(variants.id, days.variantId))
      .where(
        and(
          eq(variants.id, targetVariant),
          eq(variants.tripId, access.tripId),
          isNull(blocks.deletedAt),
          // Only blocks that actually carry a location.
          sql`${blocks.sections} -> 'map' is not null`,
        ),
      )
      .orderBy(asc(days.dayNumber), asc(blocks.sortOrder));

    const pins: MapPin[] = [];

    for (const row of rows) {
      const map = (row.sections as { map?: { lat: number; lng: number; name: string } }).map;
      if (!map || typeof map.lat !== 'number' || typeof map.lng !== 'number') continue;

      pins.push({
        blockId: row.blockId,
        dayId: row.dayId,
        dayNumber: row.dayNumber,
        blockType: row.blockType,
        title: row.title,
        name: map.name,
        lat: map.lat,
        lng: map.lng,
      });
    }

    return { pins, center: this.centerOf(pins), bounds: this.boundsOf(pins) };
  }

  /**
   * A static map image, for surfaces that cannot run JavaScript — the PDF
   * export and the public page.
   *
   * Null on the free provider, which has no first-party static image service.
   * Callers must treat that as normal, not an error.
   *
   * SECURITY: the returned URL embeds the API key, so it is only ever safe to
   * hand to a server-side renderer. Never return it to a browser.
   */
  staticMapUrl(pins: MapPin[], width = 640, height = 360): string | null {
    return maps.staticMapUrl(
      pins.map((pin) => ({ lat: pin.lat, lng: pin.lng, label: String(pin.dayNumber) })),
      { width, height },
    );
  }

  private centerOf(pins: MapPin[]): { lat: number; lng: number } | null {
    if (pins.length === 0) return null;
    const lat = pins.reduce((sum, pin) => sum + pin.lat, 0) / pins.length;
    const lng = pins.reduce((sum, pin) => sum + pin.lng, 0) / pins.length;
    return { lat, lng };
  }

  /** Bounding box, so the client can fit the viewport without guessing zoom. */
  private boundsOf(pins: MapPin[]) {
    if (pins.length === 0) return null;

    return {
      north: Math.max(...pins.map((p) => p.lat)),
      south: Math.min(...pins.map((p) => p.lat)),
      east: Math.max(...pins.map((p) => p.lng)),
      west: Math.min(...pins.map((p) => p.lng)),
    };
  }

  private async readCache(query: string): Promise<Place[] | null> {
    const rows = await db
      .select()
      .from(placeSearchCache)
      .where(and(eq(placeSearchCache.provider, maps.name), eq(placeSearchCache.query, query)))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    if (Date.now() - row.fetchedAt.getTime() > CACHE_TTL_MS) return null;

    return row.results as Place[];
  }

  private async writeCache(query: string, results: Place[]): Promise<void> {
    await db
      .insert(placeSearchCache)
      .values({ provider: maps.name, query, results: results as never })
      .onConflictDoUpdate({
        target: [placeSearchCache.provider, placeSearchCache.query],
        set: { results: results as never, fetchedAt: new Date() },
      });
  }
}

export const placesService = new PlacesService();
