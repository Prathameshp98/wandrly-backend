/**
 * Variants, days, and blocks — the itinerary tree.
 * TECHNICAL_DESIGN §5.2.
 *
 * Note the ownership chain: a Variant owns its own full day/block tree. The
 * prototype shared one tree across all variants, which made forking a no-op.
 * Deep-copy forking is the single largest implementation difference and is
 * handled in the canvas service.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { blockTypeEnum, tripStatusEnum } from './enums';
import { trips } from './trips';
import { users } from './identity';

export const variants = pgTable(
  'variants',
  {
    id: uuid('id').primaryKey(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isMain: boolean('is_main').notNull().default(false),
    forkedFromId: uuid('forked_from_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('variants_trip_idx').on(t.tripId),
    uniqueIndex('one_main_per_trip')
      .on(t.tripId)
      .where(sql`${t.isMain}`),
    check('variants_name_len', sql`char_length(${t.name}) between 1 and 40`),
  ],
);

export const days = pgTable(
  'days',
  {
    id: uuid('id').primaryKey(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'cascade' }),
    dayNumber: integer('day_number').notNull(),
    /** Derived from trip.startDate + dayNumber − 1 when trip dates exist. */
    date: date('date'),
    title: text('title').notNull().default(''),
    note: text('note').notNull().default(''),
    status: tripStatusEnum('status').notNull().default('PLANNING'),
    /** Cached forecast; absent means "hide the element", never a fabricated one. */
    weatherCache: jsonb('weather_cache'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // DEFERRABLE so renumbering after a delete can happen in one statement
    // without transiently colliding. Applied in a follow-up SQL migration.
    uniqueIndex('days_variant_number_uq').on(t.variantId, t.dayNumber),
    check('days_number_positive', sql`${t.dayNumber} > 0`),
  ],
);

export const blocks = pgTable(
  'blocks',
  {
    id: uuid('id').primaryKey(),
    dayId: uuid('day_id')
      .notNull()
      .references(() => days.id, { onDelete: 'cascade' }),
    type: blockTypeEnum('type').notNull(),
    title: text('title').notNull().default(''),
    /** Free-form display label, e.g. "02:45 → 13:20" or "Check-in 16:00". */
    timeLabel: text('time_label').notNull().default(''),
    /** Structured times, required for ICS export and chronological sort. */
    startAt: timestamp('start_at', { withTimezone: true }),
    endAt: timestamp('end_at', { withTimezone: true }),
    meta: text('meta').notNull().default(''),
    notes: text('notes'),
    isConfirmed: boolean('is_confirmed').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),

    /**
     * The six rich sections. JSONB by design: sparse, type-varying, always read
     * with their block, never queried across blocks. Six nullable join tables
     * would be six joins on the canvas's hottest read path.
     *
     * Shape validated by Zod at the API boundary (see contracts/blockSections).
     * The `booking` key is encrypted at the application layer before write.
     */
    sections: jsonb('sections').notNull().default(sql`'{}'::jsonb`),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('blocks_day_idx')
      .on(t.dayId, t.sortOrder)
      .where(sql`${t.deletedAt} is null`),
    index('blocks_confirmed_idx')
      .on(t.dayId, t.isConfirmed)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/** Trip-wide collaborative scratchpad (FR-PANEL-09, 10). */
export const tripNotes = pgTable('trip_notes', {
  tripId: uuid('trip_id')
    .primaryKey()
    .references(() => trips.id, { onDelete: 'cascade' }),
  body: text('body').notNull().default(''),
  version: integer('version').notNull().default(1),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Shared, per-trip packing list (FR-PANEL-06, 07). */
export const packingItems = pgTable(
  'packing_items',
  {
    id: uuid('id').primaryKey(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    label: text('label').notNull(),
    isChecked: boolean('is_checked').notNull().default(false),
    /** FR-PANEL-07 — per-item attribution of who packed it. */
    checkedBy: uuid('checked_by').references(() => users.id, { onDelete: 'set null' }),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    isTemplate: boolean('is_template').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('packing_trip_idx').on(t.tripId, t.category, t.sortOrder),
    check('packing_label_len', sql`char_length(${t.label}) between 1 and 120`),
  ],
);

export type VariantRow = typeof variants.$inferSelect;
export type NewVariantRow = typeof variants.$inferInsert;
export type DayRow = typeof days.$inferSelect;
export type NewDayRow = typeof days.$inferInsert;
export type BlockRow = typeof blocks.$inferSelect;
export type NewBlockRow = typeof blocks.$inferInsert;
export type PackingItemRow = typeof packingItems.$inferSelect;
export type TripNoteRow = typeof tripNotes.$inferSelect;
