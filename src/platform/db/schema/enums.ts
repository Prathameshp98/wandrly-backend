/**
 * Postgres enum types. TECHNICAL_DESIGN §5.2, §5.3, §5.8.
 *
 * Declared in one module so every table imports the same instance — Drizzle
 * emits `CREATE TYPE` once per enum object.
 */

import { customType, pgEnum } from 'drizzle-orm/pg-core';

// ── Trips and canvas ────────────────────────────────────────────────

export const tripStatusEnum = pgEnum('trip_status', [
  'DRAFT',
  'PLANNING',
  'CONFIRMED',
  'COMPLETED',
]);

export const tripModeEnum = pgEnum('trip_mode', ['FULL', 'EXPENSES_ONLY']);

export const memberRoleEnum = pgEnum('member_role', [
  'OWNER',
  'EDITOR',
  'CONTRIBUTOR',
  'VIEWER',
]);

export const blockTypeEnum = pgEnum('block_type', [
  'ACTIVITY',
  'ACCOMMODATION',
  'TRANSPORT',
  'RESTAURANT',
  'TICKET',
  'PHOTO',
  'VIDEO',
  'LINK',
  'MAP_PIN',
  'NOTE',
  'BUDGET',
]);

// ── Ledger ─────────────────────────────────────────────────────────

export const splitMethodEnum = pgEnum('split_method', [
  'EQUAL',
  'EXACT',
  'PERCENT',
  'SHARES',
  'ADJUSTMENT',
]);

export const expenseCategoryEnum = pgEnum('expense_category', [
  'TRANSPORT',
  'ACCOMMODATION',
  'FOOD',
  'ACTIVITY',
  'SHOPPING',
  'FEES',
  'GROCERIES',
  'OTHER',
]);

export const settlementMethodEnum = pgEnum('settlement_method', [
  'UPI',
  'BANK',
  'CASH',
  'OTHER',
]);

// ── Collaboration and platform ─────────────────────────────────────

export const inviteStatusEnum = pgEnum('invite_status', [
  'PENDING',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'REVOKED',
]);

export const suggestionStatusEnum = pgEnum('suggestion_status', [
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'WITHDRAWN',
]);

export const notificationKindEnum = pgEnum('notification_kind', [
  'COMMENT',
  'BLOCK',
  'INVITE',
  'EDIT',
  'MENTION',
  'EXPENSE',
  'SETTLEMENT',
  'SETTLEMENT_CONFIRMED',
  'SETTLEMENT_NUDGE',
]);

export const emailStateEnum = pgEnum('email_state', [
  'NOT_REQUIRED',
  'PENDING',
  'BATCHED',
  'SENT',
  'SUPPRESSED',
]);

/**
 * PROVIDER covers any third-party image service (Pexels today). UNSPLASH is
 * retained only because Postgres enum values cannot be dropped; nothing uses it.
 */
export const mediaSourceEnum = pgEnum('media_source', [
  'UPLOAD',
  'UNSPLASH',
  'URL',
  'PROVIDER',
]);

export const mediaStateEnum = pgEnum('media_state', ['PENDING', 'READY', 'FAILED']);

// ── Custom column types ────────────────────────────────────────────

/**
 * Case-insensitive text, backed by the `citext` extension (§5.7).
 * Used for email columns so lookups don't need `lower()` everywhere.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});
