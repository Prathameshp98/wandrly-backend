/**
 * Third-party image providers.
 *
 * An interface with swappable implementations, matching how email and storage
 * are handled: absent credentials degrade the feature rather than crashing.
 *
 * ── Why the attachment mode is per-provider ──────────────────────────
 * Providers disagree on something fundamental:
 *
 *   Pexels   — permits self-hosting. Attribution to Pexels AND the
 *              photographer is MANDATORY.
 *   Pixabay  — REQUIRES you to download and cache; hotlinking is forbidden.
 *   Unsplash — REQUIRES hotlinking their CDN and FORBIDS caching, and you must
 *              ping /photos/:id/download when a user picks a photo.
 *
 * A single storage strategy cannot satisfy both camps, so each provider
 * declares its own `attachMode` and the media service obeys it.
 */

export type AttachMode =
  /** Download the bytes and serve them from our own storage. */
  | 'IMPORT'
  /** Never self-host — embed the provider's CDN URL directly. */
  | 'REFERENCE';

export interface ProviderPhoto {
  /** The provider's own id. */
  readonly id: string;
  readonly description: string;
  /** Full-size URL, used for import. */
  readonly url: string;
  /** Smaller URL for the picker grid. */
  readonly thumbUrl: string;
  readonly width: number;
  readonly height: number;
  /** Average colour, for a placeholder while loading. */
  readonly tone: string | null;
  readonly photographer: string;
  /** Link to the photographer's page — required to render attribution. */
  readonly photographerUrl: string;
  /** Link to the photo on the provider, also required by their terms. */
  readonly sourceUrl: string;
}

export interface SearchResult {
  readonly photos: ProviderPhoto[];
  readonly page: number;
  readonly totalPages: number;
}

export interface ImageProvider {
  readonly name: string;
  readonly attachMode: AttachMode;
  /** Rendered next to results — a licence obligation, not branding. */
  readonly attributionLabel: string;
  readonly isConfigured: boolean;
  search(query: string, page: number, perPage: number): Promise<SearchResult>;
  /**
   * Called when a user actually picks a photo.
   *
   * Unsplash requires this ping; Pexels does not. Implemented as a no-op where
   * unnecessary so callers do not need to know which is which.
   */
  trackUse(photo: ProviderPhoto): Promise<void>;
}
