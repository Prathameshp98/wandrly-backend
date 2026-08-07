/**
 * Users, preferences, and media. TECHNICAL_DESIGN §5.2, §5.8.
 *
 * `users` mirrors Supabase `auth.users` (decision T-2) so joins stay local and
 * the exit path off Supabase is preserved.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { citext, mediaSourceEnum, mediaStateEnum } from './enums';

export const users = pgTable(
  'users',
  {
    /** Same id as Supabase `auth.users.id`. */
    id: uuid('id').primaryKey(),
    email: citext('email').notNull(),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url'),
    avatarTone: text('avatar_tone').notNull().default('gold'),
    homeCity: text('home_city'),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    locale: text('locale').notNull().default('en-IN'),
    defaultCurrency: char('default_currency', { length: 3 }).notNull().default('INR'),
    plan: text('plan').notNull().default('free'),
    emailNotificationsEnabled: boolean('email_notifications_enabled').notNull().default(true),
    weeklyDigestEnabled: boolean('weekly_digest_enabled').notNull().default(false),
    /** Set at the start of account deletion (FR-AUTH-07); purged by a job. */
    pendingDeletionAt: timestamp('pending_deletion_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (t) => [index('users_email_uq').using('btree', t.email)],
);

/**
 * Appearance preferences. FR-SET-03 requires these to persist per user ACROSS
 * DEVICES, which is why they are a server-side row rather than localStorage.
 */
export const userPreferences = pgTable('user_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  theme: text('theme').notNull().default('dark'),
  accent: text('accent').notNull().default('#F0A05A'),
  treatment: text('treatment').notNull().default('clean'),
  typeEmphasis: text('type_emphasis').notNull().default('utility'),
  blockLayout: text('block_layout').notNull().default('rows'),
  density: text('density').notNull().default('standard'),
  showCompass: boolean('show_compass').notNull().default(false),
  showQuote: boolean('show_quote').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Media assets. Created before `trips` because `trips.cover_asset_id`
 * references it — see the migration ordering note in §5.7.
 */
export const mediaAssets = pgTable(
  'media_assets',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    /** Null for UNSPLASH / URL sources. */
    storageKey: text('storage_key'),
    /** Unsplash photo id, or a remote URL. */
    externalRef: text('external_ref'),
    source: mediaSourceEnum('source').notNull(),
    mimeType: text('mime_type'),
    byteSize: integer('byte_size'),
    width: integer('width'),
    height: integer('height'),
    blurhash: text('blurhash'),
    /** FR-NFR-A11Y-09 — alt text must at least be storable. */
    altText: text('alt_text'),
    /** Unsplash licence compliance. */
    /** Photographer credit. A licence obligation for Pexels, not a nicety. */
    attribution: text('attribution'),
    attributionUrl: text('attribution_url'),
    /** Which service supplied it, e.g. 'pexels'. Null for user uploads. */
    provider: text('provider'),
    providerPhotoId: text('provider_photo_id'),
    /**
     * Set only in REFERENCE mode, where the provider's terms forbid
     * self-hosting and we must embed their CDN URL directly.
     */
    remoteUrl: text('remote_url'),
    state: mediaStateEnum('state').notNull().default('PENDING'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('media_owner_idx').on(t.ownerId),
    // Supports the orphan-purge job without scanning the table.
    index('media_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.state} = 'PENDING'`),
  ],
);

/**
 * Idempotency keys (§8.8). Required for expense and settlement creation — a
 * double-tap on a flaky connection must not create two ₹5,000 expenses.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    route: text('route').notNull(),
    /** Rejects key reuse with a different body rather than replaying wrongly. */
    requestHash: text('request_hash').notNull(),
    statusCode: integer('status_code'),
    response: text('response'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idempotency_created_idx').on(t.createdAt)],
);

/** Daily FX rates (FR-SPLIT-19). Rates are copied onto each expense at write. */
export const fxRates = pgTable(
  'fx_rates',
  {
    baseCurrency: char('base_currency', { length: 3 }).notNull(),
    quoteCurrency: char('quote_currency', { length: 3 }).notNull(),
    /** Decimal string, scale 8. Never a float. */
    rate: text('rate').notNull(),
    asOf: text('as_of').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('fx_lookup_idx').on(t.baseCurrency, t.quoteCurrency, t.asOf),
  ],
);

/**
 * Provider search cache. Pexels allows 200 requests/hour — a search-as-you-type
 * field would exhaust that in minutes, so repeated queries never hit the wire.
 */
export const imageSearchCache = pgTable(
  'image_search_cache',
  {
    provider: text('provider').notNull(),
    query: text('query').notNull(),
    page: integer('page').notNull(),
    results: jsonb('results').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.query, t.page] })],
);

/**
 * Geocoding cache. Google bills per request beyond its free allowance, and
 * Nominatim asks clients to cache and stay under ~1 req/sec — so an uncached
 * autocomplete field is either expensive or rude, depending on the provider.
 */
export const placeSearchCache = pgTable(
  'place_search_cache',
  {
    provider: text('provider').notNull(),
    query: text('query').notNull(),
    results: jsonb('results').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.query] })],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type UserPreferencesRow = typeof userPreferences.$inferSelect;
export type MediaAssetRow = typeof mediaAssets.$inferSelect;
