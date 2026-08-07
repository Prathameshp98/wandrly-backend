/**
 * Expense ledger contracts. TECHNICAL_DESIGN §8.2, FR-SPLIT-*.
 */

import { z } from 'zod';

import {
  CurrencyCode,
  DecimalRate,
  ExpenseCategory,
  IsoDateTime,
  MoneyString,
  NonZeroMoneyString,
  PositiveMoneyString,
  SettlementMethod,
  Uuid,
} from './common';

// ── Participants ────────────────────────────────────────────────────

export const ParticipantDTO = z.object({
  id: Uuid,
  userId: Uuid.nullable(),
  displayName: z.string(),
  avatarTone: z.string(),
  isPlaceholder: z.boolean(),
  isActive: z.boolean(),
  claimedAt: IsoDateTime.nullable(),
  hasPayoutDetails: z.boolean(),
});

export const AddParticipantBody = z.object({
  displayName: z.string().trim().min(1).max(40),
  avatarTone: z.enum(['gold', 'teal', 'sienna', 'forest']).default('gold'),
  /** Optional: send a claim invite so they can take over this identity later. */
  claimInviteEmail: z.string().email().optional(),
});

export const UpdateParticipantBody = z.object({
  displayName: z.string().trim().min(1).max(40).optional(),
  avatarTone: z.enum(['gold', 'teal', 'sienna', 'forest']).optional(),
  /** Encrypted at rest; only ever readable by co-participants. */
  payoutUpiId: z.string().trim().max(120).nullable().optional(),
  payoutBankRef: z.string().trim().max(200).nullable().optional(),
});

export const RemoveParticipantQuery = z.object({
  /** Required when the participant still has ledger history (FR-SPLIT-04). */
  reassignToParticipantId: Uuid.optional(),
});

// ── Splits ──────────────────────────────────────────────────────────

const ParticipantAmount = z.object({
  participantId: Uuid,
  amountMinor: MoneyString,
});

const ParticipantWeight = z.object({
  participantId: Uuid,
  weight: z.number().int().positive().max(1000),
});

const ParticipantPercent = z.object({
  participantId: Uuid,
  percent: z.number().positive().max(100),
});

/**
 * Discriminated union so an invalid split combination is rejected at the
 * boundary, and appears in the OpenAPI spec as a `oneOf` any generated client
 * models correctly.
 */
export const SplitInput = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('EQUAL'),
    participantIds: z.array(Uuid).min(1).max(50),
  }),
  z.object({
    method: z.literal('EXACT'),
    shares: z.array(ParticipantAmount).min(1).max(50),
  }),
  z.object({
    method: z.literal('PERCENT'),
    shares: z.array(ParticipantPercent).min(1).max(50),
  }),
  z.object({
    method: z.literal('SHARES'),
    shares: z.array(ParticipantWeight).min(1).max(50),
  }),
  z.object({
    method: z.literal('ADJUSTMENT'),
    participantIds: z.array(Uuid).min(1).max(50),
    adjustments: z.array(ParticipantAmount).max(50).default([]),
  }),
]);

export type SplitInput = z.infer<typeof SplitInput>;

// ── Expenses ────────────────────────────────────────────────────────

const PaymentInput = z
  .array(z.object({ participantId: Uuid, amountMinor: MoneyString }))
  .min(1)
  .max(50);

export const CreateExpenseBody = z.object({
  description: z.string().trim().min(1).max(120),
  amountMinor: NonZeroMoneyString,
  currency: CurrencyCode,
  spentAt: IsoDateTime.optional(),
  category: ExpenseCategory.optional(),
  /** The plan-to-spend link (FR-SPLIT-08). */
  blockId: Uuid.nullish(),
  dayId: Uuid.nullish(),
  payments: PaymentInput,
  split: SplitInput,
  /** Override the auto-fetched rate with the one you actually got (FR-SPLIT-20). */
  fxRateOverride: DecimalRate.optional(),
  receiptAssetIds: z.array(Uuid).max(10).default([]),
  note: z.string().trim().max(500).optional(),
});

export const UpdateExpenseBody = CreateExpenseBody.partial()
  .extend({ version: z.number().int().positive() })
  .refine((value) => Object.keys(value).length > 1, {
    message: 'Provide at least one field to update',
  });

export const ExpenseShareDTO = z.object({
  participantId: Uuid,
  participantName: z.string(),
  shareAmountMinor: MoneyString,
  shareAmountBaseMinor: MoneyString,
});

export const ExpensePaymentDTO = z.object({
  participantId: Uuid,
  participantName: z.string(),
  amountMinor: MoneyString,
  amountBaseMinor: MoneyString,
});

export const ExpenseDTO = z.object({
  id: Uuid,
  tripId: Uuid,
  description: z.string(),
  amountMinor: MoneyString,
  currency: CurrencyCode,
  amountBaseMinor: MoneyString,
  baseCurrency: CurrencyCode,
  fxRateToBase: z.string(),
  fxRateSource: z.enum(['AUTO', 'MANUAL']),
  spentAt: IsoDateTime,
  category: ExpenseCategory,
  splitMethod: z.string(),
  blockId: Uuid.nullable(),
  dayId: Uuid.nullable(),
  note: z.string().nullable(),
  receiptAssetIds: z.array(Uuid),
  payments: z.array(ExpensePaymentDTO),
  shares: z.array(ExpenseShareDTO),
  /** The requesting user's own share, for the list row. */
  yourShareMinor: MoneyString.nullable(),
  createdBy: Uuid,
  version: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ListExpensesQuery = z.object({
  participantId: Uuid.optional(),
  category: ExpenseCategory.optional(),
  linked: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

// ── Balances and settlement ─────────────────────────────────────────

export const BalanceDTO = z.object({
  participantId: Uuid,
  displayName: z.string(),
  isPlaceholder: z.boolean(),
  paidMinor: MoneyString,
  owedMinor: MoneyString,
  settlementsSentMinor: MoneyString,
  settlementsReceivedMinor: MoneyString,
  /** > 0 ⇒ this participant is owed money. */
  netMinor: MoneyString,
});

export const BalancesResponse = z.object({
  baseCurrency: CurrencyCode,
  totalSpentMinor: MoneyString,
  isFullySettled: z.boolean(),
  balances: z.array(BalanceDTO),
});

export const TransferDTO = z.object({
  fromParticipantId: Uuid,
  fromName: z.string(),
  toParticipantId: Uuid,
  toName: z.string(),
  amountMinor: MoneyString,
  /** Present when the payee has saved payout details (FR-SPLIT-27). */
  upiDeepLink: z.string().nullable(),
  payeeUpiId: z.string().nullable(),
});

export const SettleUpResponse = z.object({
  baseCurrency: CurrencyCode,
  simplified: z.boolean(),
  transfers: z.array(TransferDTO),
});

export const SettleUpQuery = z.object({
  simplify: z
    .enum(['true', 'false'])
    .optional()
    .describe('Overrides the trip’s simplifyDebts setting for this request'),
});

export const RecordSettlementBody = z.object({
  fromParticipantId: Uuid,
  toParticipantId: Uuid,
  amountMinor: PositiveMoneyString,
  method: SettlementMethod.default('OTHER'),
  note: z.string().trim().max(200).optional(),
  settledAt: IsoDateTime.optional(),
});

export const VoidSettlementBody = z.object({
  reason: z.string().trim().min(1).max(200),
});

export const SettlementDTO = z.object({
  id: Uuid,
  tripId: Uuid,
  fromParticipantId: Uuid,
  fromName: z.string(),
  toParticipantId: Uuid,
  toName: z.string(),
  amountMinor: MoneyString,
  currency: CurrencyCode,
  method: SettlementMethod,
  note: z.string().nullable(),
  settledAt: IsoDateTime,
  recordedBy: Uuid,
  confirmedByPayee: z.boolean(),
  confirmedAt: IsoDateTime.nullable(),
  voidedAt: IsoDateTime.nullable(),
  voidReason: z.string().nullable(),
});

// ── Reporting ───────────────────────────────────────────────────────

export const LedgerSummaryResponse = z.object({
  baseCurrency: CurrencyCode,
  expenseCount: z.number().int(),
  totalSpentMinor: MoneyString,
  /** From block Cost sections — the estimate (FR-SPLIT-35). */
  plannedTotalMinor: MoneyString,
  /** From expenses — the actual. */
  actualTotalMinor: MoneyString,
  varianceMinor: MoneyString,
  byCategory: z.array(
    z.object({ category: ExpenseCategory, totalMinor: MoneyString, count: z.number().int() }),
  ),
  linkedExpenseCount: z.number().int(),
  unlinkedExpenseCount: z.number().int(),
});

export type CreateExpenseBody = z.infer<typeof CreateExpenseBody>;
export type UpdateExpenseBody = z.infer<typeof UpdateExpenseBody>;
export type AddParticipantBody = z.infer<typeof AddParticipantBody>;
export type UpdateParticipantBody = z.infer<typeof UpdateParticipantBody>;
export type RecordSettlementBody = z.infer<typeof RecordSettlementBody>;
export type ExpenseDTO = z.infer<typeof ExpenseDTO>;
export type BalanceDTO = z.infer<typeof BalanceDTO>;
export type ListExpensesQuery = z.infer<typeof ListExpensesQuery>;
