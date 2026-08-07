-- Geocoding cache.
-- PRD FR-TRIP-02 / FR-SEC-04, TECHNICAL_DESIGN §11.2.
--
-- Two reasons this is not optional:
--   • Google bills per request beyond the free SKU allowance, so an uncached
--     autocomplete field turns keystrokes into money.
--   • Nominatim (the free fallback) has a published limit of ~1 request/second
--     and asks that clients cache. Ignoring that gets you blocked.

CREATE TABLE IF NOT EXISTS place_search_cache (
  provider   TEXT NOT NULL,
  query      TEXT NOT NULL,
  results    JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, query)
);

CREATE INDEX IF NOT EXISTS place_search_cache_age ON place_search_cache (fetched_at);
