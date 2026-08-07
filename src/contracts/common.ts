/**
 * Shared contract primitives.
 *
 * TECHNICAL_DESIGN §8.2. These Zod schemas are the single source of truth for
 * runtime validation, TypeScript types, and the generated OpenAPI spec that the
 * (undecided) frontend will consume.
 */

import { z } from 'zod';

const INTEGER_STRING = /^-?\d+$/;

/** Money on the wire: a minor-unit integer as a STRING. See money/index.ts. */
export const MoneyString = z
  .string()
  .regex(INTEGER_STRING, 'Expected an integer amount in minor units')
  .describe('Amount in the currency’s minor units, as a string (e.g. "580000" = ₹5,800.00)');

/**
 * Build a refinement that is safe to chain onto `MoneyString`.
 *
 * Zod runs `.refine()` even when a preceding `.regex()` has already failed, so a
 * naive `BigInt(value)` inside a refinement throws a raw SyntaxError on
 * malformed input — surfacing as a 500 instead of a 400. Short-circuiting on the
 * regex keeps the refinement total.
 */
const moneyRefinement =
  (predicate: (amount: bigint) => boolean) =>
  (value: string): boolean =>
    !INTEGER_STRING.test(value) || predicate(BigInt(value));

export const PositiveMoneyString = MoneyString.refine(moneyRefinement((v) => v > 0n), {
  message: 'Amount must be greater than zero',
});

export const NonZeroMoneyString = MoneyString.refine(moneyRefinement((v) => v !== 0n), {
  message: 'Amount cannot be zero',
});

export const CurrencyCode = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'Expected an ISO 4217 currency code')
  .describe('ISO 4217 currency code');

export const DecimalRate = z
  .string()
  .regex(/^\d+(\.\d{1,8})?$/, 'Expected a positive decimal with up to 8 places');

export const Uuid = z.string().uuid();

export const IsoDateTime = z.string().datetime({ offset: true });

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

// ── Route params ────────────────────────────────────────────────────

export const TripIdParam = z.object({ tripId: Uuid });
export const IdParam = z.object({ id: Uuid });
export const TripAndIdParam = z.object({ tripId: Uuid, id: Uuid });

// ── Pagination ──────────────────────────────────────────────────────

export const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export type Pagination = z.infer<typeof PaginationQuery>;

export const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });

// ── Optimistic concurrency ──────────────────────────────────────────

/**
 * Clients echo the version they read; a mismatch returns 409 with the current
 * server state (§5.9, §8.5).
 */
export const VersionedBody = z.object({
  version: z.number().int().positive(),
});

// ── Enums mirrored from the schema ──────────────────────────────────

export const MemberRole = z.enum(['OWNER', 'EDITOR', 'CONTRIBUTOR', 'VIEWER']);
export const TripStatus = z.enum(['DRAFT', 'PLANNING', 'CONFIRMED', 'COMPLETED']);
export const TripMode = z.enum(['FULL', 'EXPENSES_ONLY']);

export const BlockType = z.enum([
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

/** Types that carry a booked/open state and count toward readiness (FR-DASH-07). */
export const BOOKABLE_BLOCK_TYPES = [
  'ACCOMMODATION',
  'TRANSPORT',
  'RESTAURANT',
  'TICKET',
] as const;

export const ExpenseCategory = z.enum([
  'TRANSPORT',
  'ACCOMMODATION',
  'FOOD',
  'ACTIVITY',
  'SHOPPING',
  'FEES',
  'GROCERIES',
  'OTHER',
]);

export const SplitMethod = z.enum(['EQUAL', 'EXACT', 'PERCENT', 'SHARES', 'ADJUSTMENT']);
export const SettlementMethod = z.enum(['UPI', 'BANK', 'CASH', 'OTHER']);

/** Maps a block type to a sensible expense category (FR-SPLIT-08 pre-fill). */
export const CATEGORY_FOR_BLOCK_TYPE: Readonly<
  Partial<Record<z.infer<typeof BlockType>, z.infer<typeof ExpenseCategory>>>
> = Object.freeze({
  TRANSPORT: 'TRANSPORT',
  ACCOMMODATION: 'ACCOMMODATION',
  RESTAURANT: 'FOOD',
  ACTIVITY: 'ACTIVITY',
  TICKET: 'ACTIVITY',
  BUDGET: 'OTHER',
});
