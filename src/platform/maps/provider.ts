/**
 * Places and geocoding.
 *
 * Note what is NOT here: rendering. Drawing a map is the client's job — the
 * Google Maps JS API and MapLibre both run in the browser. The backend's role
 * is to turn text into coordinates, keep the API key server-side, and hand the
 * client the pins to draw.
 */

export interface Place {
  /** Provider's stable id, stored on the block so it can be re-resolved. */
  readonly placeId: string;
  readonly name: string;
  /** Full human-readable address, for the secondary line in a picker. */
  readonly address: string;
  readonly lat: number;
  readonly lng: number;
  /** e.g. 'restaurant', 'lodging' — used to suggest a block type. */
  readonly category: string | null;
}

export interface MapsProvider {
  readonly name: string;
  readonly isConfigured: boolean;
  /** Whether this provider can produce a static map image URL. */
  readonly supportsStaticMaps: boolean;

  /** Free-text search, for the destination and location pickers. */
  search(query: string, limit: number): Promise<Place[]>;

  /** Resolve a previously-returned id to fresh coordinates. */
  details(placeId: string): Promise<Place | null>;

  /**
   * A static map image showing the given pins.
   *
   * Used by the PDF export and the public page, where an interactive map is
   * not possible. Returns null when the provider cannot produce one.
   */
  staticMapUrl(
    pins: { lat: number; lng: number; label?: string }[],
    options: { width: number; height: number },
  ): string | null;
}
