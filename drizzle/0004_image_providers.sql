-- Third-party image providers (Pexels, and any future source).
-- PRD FR-MEDIA-*, TECHNICAL_DESIGN §11.1.
--
-- Two attachment modes exist because providers disagree on a fundamental point:
--   • Pexels / Pixabay  — downloading and self-hosting is permitted (Pixabay
--                         actually REQUIRES it and forbids hotlinking).
--   • Unsplash          — REQUIRES hotlinking their CDN and FORBIDS caching.
-- A single storage strategy cannot satisfy both, so the mode is per-asset.

-- 'PROVIDER' replaces the never-used 'UNSPLASH' value with something generic.
ALTER TYPE media_source ADD VALUE IF NOT EXISTS 'PROVIDER';

ALTER TABLE media_assets
  -- Which service supplied it, e.g. 'pexels'. Null for user uploads.
  ADD COLUMN IF NOT EXISTS provider TEXT,
  -- The provider's own id, so the same photo is imported once per user.
  ADD COLUMN IF NOT EXISTS provider_photo_id TEXT,
  -- Link back to the photographer's page. Attribution is a LICENCE OBLIGATION
  -- for Pexels, not a nicety, so the data to render it is mandatory.
  ADD COLUMN IF NOT EXISTS attribution_url TEXT,
  -- Populated only in REFERENCE mode, where we must not self-host the bytes.
  ADD COLUMN IF NOT EXISTS remote_url TEXT;

-- Import the same provider photo twice for one user and you get the same row.
CREATE UNIQUE INDEX IF NOT EXISTS media_provider_photo_uq
  ON media_assets (owner_id, provider, provider_photo_id)
  WHERE provider IS NOT NULL AND owner_id IS NOT NULL;

-- Cache of provider search results. Pexels allows 200 requests/hour, which a
-- search-as-you-type field would exhaust in minutes; this keeps repeated
-- queries off the network entirely.
CREATE TABLE IF NOT EXISTS image_search_cache (
  provider     TEXT NOT NULL,
  query        TEXT NOT NULL,
  page         INTEGER NOT NULL,
  results      JSONB NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, query, page)
);

CREATE INDEX IF NOT EXISTS image_search_cache_age ON image_search_cache (fetched_at);
