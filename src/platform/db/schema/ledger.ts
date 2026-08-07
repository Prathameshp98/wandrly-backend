/**
 * The expense ledger. TECHNICAL_DESIGN §5.3.
 *
 * Two invariants this schema exists to make unbreakable:
 *
 *   1. Shares and payments each sum EXACTLY to the expense total, in BOTH the
 *      expense currency and the trip's base currency. Enforced by deferred
 *      constraint triggers (see drizzle/0002_ledger_invariants.sql), so an
 *      unbalanced expense cannot be committed regardless of application bugs.
 *
 *   2. SUM(net balance) === 0 across all participants of a trip.
 *
 * Base-currency amounts are STORED per share, never derived at read time. The
 * sum of rounded values is not the rounded sum, so converting each share on
 * read can break invariant 2 by one minor unit and silently corrupt settle-up.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  expenseCategoryEnum,
  settlementMethodEnum,
  splitMethodEnum,
  citext,
} from './enums';
import { blocks, days } from './canvas';
import { trips } from './trips';
import { users } from './identity';

/**
 * The ledger's unit of identity — NOT `users`.
 *
 * A participant may have no account at all (a placeholder like "Mom"). Every
 * payer and every share references a participant, which is what makes
 * FR-SPLIT-01 work without weakening the auth model. This is the one modelling
 * decision that is genuinely painful to retrofit onto live financial records.
 */
export const tripParticipants = pgTable(
  'trip_participants',
  {
    id: uuid('id').primaryKey(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    /** NULL ⇒ placeholder participant with no account. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    displayName: text('display_name').notNull(),
    avatarTone: text('avatar_tone').notNull().default('gold'),
    claimInviteEmail: citext('claim_invite_email'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /** Encrypted at rest (FR-NFR-SEC-11). */
    payoutUpiId: text('payout_upi_id'),
    payoutBankRef: text('payout_bank_ref'),
    /** Soft removal — a participant with history can never be hard-deleted. */
    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('participants_trip_idx').on(t.tripId),
    // A user appears at most once per trip's ledger.
    uniqueIndex('participants_trip_user_uq')
      .on(t.tripId, t.userId)
      .where(sql`${t.userId} is not null`),
    check('participants_name_len', sql`char_length(${t.displayName}) between 1 and 40`),
  ],
);

export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey(),
    /** Trip-scoped, NOT variant-scoped: actual money is spent once (FR-SPLIT-09). */
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),

    /** Minor units of `currency`. Negative permitted — refunds (FR-SPLIT-14). */
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),

    /** Frozen at creation. Balances must never shift because a rate moved. */
    fxRateToBase: numeric('fx_rate_to_base', { precision: 18, scale: 8 }).notNull(),
    fxRateSource: text('fx_rate_source').notNull().default('AUTO'),
    /** Derived once at write, in the trip's base currency. */
    amountBaseMinor: bigint('amount_base_minor', { mode: 'bigint' }).notNull(),

    spentAt: timestamp('spent_at', { withTimezone: true }).notNull(),
    category: expenseCategoryEnum('category').notNull().default('OTHER'),
    splitMethod: splitMethodEnum('split_method').notNull().default('EQUAL'),

    /**
     * The plan-to-spend link — the feature's differentiator (FR-SPLIT-08).
     * ON DELETE SET NULL, not CASCADE: an expense is a financial record and
     * must survive an itinerary edit (FR-SPLIT-09).
     */
    blockId: uuid('block_id').references(() => blocks.id, { onDelete: 'set null' }),
    dayId: uuid('day_id').references(() => days.id, { onDelete: 'set null' }),

    receiptAssetIds: uuid('receipt_asset_ids').array().notNull().default(sql`'{}'::uuid[]`),
    note: text('note'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('expenses_trip_idx')
      .on(t.tripId, t.spentAt)
      .where(sql`${t.deletedAt} is null`),
    index('expenses_block_idx')
      .on(t.blockId)
      .where(sql`${t.blockId} is not null and ${t.deletedAt} is null`),
    check('expenses_nonzero', sql`${t.amountMinor} <> 0`),
    check('expenses_desc_len', sql`char_length(${t.description}) between 1 and 120`),
    check('expenses_fx_positive', sql`${t.fxRateToBase} > 0`),
    check('expenses_fx_source', sql`${t.fxRateSource} in ('AUTO','MANUAL')`),
  ],
);

/**
 * Who actually paid.
 *
 * Modelled as a collection from day one even though v1's UI creates a single
 * row — two people splitting a bill at the counter is common enough that
 * retrofitting this later means migrating live financial records.
 */
export const expensePayments = pgTable(
  'expense_payments',
  {
    id: uuid('id').primaryKey(),
    expenseId: uuid('expense_id')
      .notNull()
      .references(() => expenses.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => tripParticipants.id, { onDelete: 'restrict' }),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    amountBaseMinor: bigint('amount_base_minor', { mode: 'bigint' }).notNull(),
  },
  (t) => [
    uniqueIndex('payments_expense_participant_uq').on(t.expenseId, t.participantId),
    index('payments_participant_idx').on(t.participantId),
  ],
);

/** Who owes what. */
export const expenseShares = pgTable(
  'expense_shares',
  {
    expenseId: uuid('expense_id')
      .notNull()
      .references(() => expenses.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => tripParticipants.id, { onDelete: 'restrict' }),
    shareAmountMinor: bigint('share_amount_minor', { mode: 'bigint' }).notNull(),
    shareAmountBaseMinor: bigint('share_amount_base_minor', { mode: 'bigint' }).notNull(),
    /** Raw weight / percent / adjustment, retained so a split can be re-edited. */
    shareInput: numeric('share_input', { precision: 18, scale: 6 }),
  },
  (t) => [
    primaryKey({ columns: [t.expenseId, t.participantId] }),
    index('shares_participant_idx').on(t.participantId),
  ],
);

/**
 * A recorded transfer between two participants.
 *
 * Wandrly records it; it never performs it. No PSP, no held funds, no PCI
 * scope — see TECHNICAL_DESIGN §7.18.1.
 */
export const settlements = pgTable(
  'settlements',
  {
    id: uuid('id').primaryKey(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    fromParticipantId: uuid('from_participant_id')
      .notNull()
      .references(() => tripParticipants.id, { onDelete: 'restrict' }),
    toParticipantId: uuid('to_participant_id')
      .notNull()
      .references(() => tripParticipants.id, { onDelete: 'restrict' }),
    /** Always the trip's base currency, so no conversion is ever needed. */
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    method: settlementMethodEnum('method').notNull().default('OTHER'),
    note: text('note'),
    settledAt: timestamp('settled_at', { withTimezone: true }).notNull().defaultNow(),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => tripParticipants.id, { onDelete: 'restrict' }),
    confirmedByPayee: boolean('confirmed_by_payee').notNull().default(false),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /** Voided, never deleted — settlement history is permanent (FR-SPLIT-31). */
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('settlements_trip_idx')
      .on(t.tripId)
      .where(sql`${t.voidedAt} is null`),
    index('settlements_nudge_idx')
      .on(t.settledAt)
      .where(sql`${t.voidedAt} is null and ${t.confirmedByPayee} = false`),
    check('settlements_positive', sql`${t.amountMinor} > 0`),
    check('settlements_distinct', sql`${t.fromParticipantId} <> ${t.toParticipantId}`),
  ],
);

export type TripParticipantRow = typeof tripParticipants.$inferSelect;
export type NewTripParticipantRow = typeof tripParticipants.$inferInsert;
export type ExpenseRow = typeof expenses.$inferSelect;
export type NewExpenseRow = typeof expenses.$inferInsert;
export type ExpenseShareRow = typeof expenseShares.$inferSelect;
export type ExpensePaymentRow = typeof expensePayments.$inferSelect;
export type SettlementRow = typeof settlements.$inferSelect;
export type NewSettlementRow = typeof settlements.$inferInsert;
