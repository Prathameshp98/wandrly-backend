/**
 * Trips, folders, membership, and per-user trip state.
 * TECHNICAL_DESIGN §5.2.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { mediaAssets, users } from './identity';
import { memberRoleEnum, tripModeEnum, tripStatusEnum } from './enums';

export const folders = pgTable(
  'folders',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    emoji: text('emoji').notNull(),
    tone: text('tone').notNull(),
    isPinned: boolean('is_pinned').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('folders_owner_idx').on(t.ownerId, t.sortOrder),
    check('folders_name_len', sql`char_length(${t.name}) between 1 and 40`),
  ],
);

export const trips = pgTable(
  'trips',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    folderId: uuid('folder_id').references(() => folders.id, { onDelete: 'set null' }),

    title: text('title').notNull(),
    subtitle: text('subtitle').notNull().default(''),
    destination: text('destination').notNull().default(''),
    placeId: text('place_id'),

    /**
     * Real dates, not display strings. The prototype stored only a formatted
     * label, which blocks calendar export, countdown, weather, and sorting.
     */
    startDate: date('start_date'),
    endDate: date('end_date'),

    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),

    status: tripStatusEnum('status').notNull().default('DRAFT'),
    tripMode: tripModeEnum('trip_mode').notNull().default('FULL'),

    /** Currency all ledger balances are expressed in (§5.2). */
    baseCurrency: char('base_currency', { length: 3 }).notNull().default('INR'),
    /** FR-SPLIT-26 — some groups prefer paying who they actually owe. */
    simplifyDebts: boolean('simplify_debts').notNull().default(true),

    coverAssetId: uuid('cover_asset_id').references(() => mediaAssets.id, {
      onDelete: 'set null',
    }),
    coverHue: smallint('cover_hue').notNull().default(200),
    coverHue2: smallint('cover_hue2').notNull().default(240),

    /** FK added in a follow-up migration; `variants` does not exist yet here. */
    mainVariantId: uuid('main_variant_id'),

    isArchived: boolean('is_archived').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    /** Optimistic locking (§5.9). */
    version: integer('version').notNull().default(1),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('trips_owner_idx')
      .on(t.ownerId)
      .where(sql`${t.deletedAt} is null`),
    index('trips_folder_idx')
      .on(t.folderId)
      .where(sql`${t.deletedAt} is null`),
    // Supports the "next upcoming trip" query (FR-DASH-05).
    index('trips_upcoming_idx')
      .on(t.startDate)
      .where(sql`${t.deletedAt} is null and ${t.isArchived} = false`),
    check('trips_title_len', sql`char_length(${t.title}) between 1 and 80`),
    check(
      'trips_date_order',
      sql`${t.endDate} is null or ${t.startDate} is null or ${t.endDate} >= ${t.startDate}`,
    ),
  ],
);

/**
 * Per-user trip state.
 *
 * Pinning and ordering are per-user, not per-trip (FR-TRIP-06). The prototype
 * stored `pinned` on the trip, which would let one member's pin reorder
 * everyone else's dashboard.
 */
export const tripUserState = pgTable(
  'trip_user_state',
  {
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    isPinned: boolean('is_pinned').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tripId, t.userId] })],
);

export const tripMembers = pgTable(
  'trip_members',
  {
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRoleEnum('role').notNull(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    /** Drives the presence "live" ring (§9). */
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tripId, t.userId] }),
    index('trip_members_user_idx').on(t.userId),
    // Exactly one owner per trip, enforced by the database.
    uniqueIndex('one_owner_per_trip')
      .on(t.tripId)
      .where(sql`${t.role} = 'OWNER'`),
  ],
);

export type TripRow = typeof trips.$inferSelect;
export type NewTripRow = typeof trips.$inferInsert;
export type FolderRow = typeof folders.$inferSelect;
export type TripMemberRow = typeof tripMembers.$inferSelect;
export type TripUserStateRow = typeof tripUserState.$inferSelect;
