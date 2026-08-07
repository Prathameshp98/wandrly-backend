/**
 * Row → DTO mapping.
 *
 * Kept separate from the service so serialisation concerns never leak into
 * business logic (Single Responsibility), and so there is exactly one place
 * that decides what leaves the server.
 *
 * Two invariants enforced here:
 *   • `bigint` is serialised as a STRING — JSON.stringify throws on bigint and
 *     Number loses precision above 2^53.
 *   • Payout identifiers are NEVER emitted, only a `hasPayoutDetails` boolean.
 */

import type { ExpenseRow, SettlementRow, TripParticipantRow } from '../../platform/db/schema/index';
import type { BalanceRow } from './ledger.repository';
import type { Transfer } from './ledger.service';

const money = (value: bigint): string => value.toString();

export function toParticipantDTO(row: TripParticipantRow) {
  return {
    id: row.id,
    userId: row.userId,
    displayName: row.displayName,
    avatarTone: row.avatarTone,
    isPlaceholder: row.userId === null,
    isActive: row.isActive,
    claimedAt: row.claimedAt?.toISOString() ?? null,
    // Deliberately a boolean, never the encrypted value (FR-NFR-SEC-11).
    hasPayoutDetails: Boolean(row.payoutUpiId || row.payoutBankRef),
  };
}

export interface ExpenseViewModel {
  expense: ExpenseRow;
  baseCurrency: string;
  payments: { participantId: string; participantName: string; amountMinor: bigint; amountBaseMinor: bigint }[];
  shares: {
    participantId: string;
    participantName: string;
    shareAmountMinor: bigint;
    shareAmountBaseMinor: bigint;
  }[];
  yourShareMinor: bigint | null;
}

export function toExpenseDTO(model: ExpenseViewModel) {
  const { expense } = model;

  return {
    id: expense.id,
    tripId: expense.tripId,
    description: expense.description,
    amountMinor: money(expense.amountMinor),
    currency: expense.currency,
    amountBaseMinor: money(expense.amountBaseMinor),
    baseCurrency: model.baseCurrency,
    fxRateToBase: expense.fxRateToBase,
    fxRateSource: expense.fxRateSource as 'AUTO' | 'MANUAL',
    spentAt: expense.spentAt.toISOString(),
    category: expense.category,
    splitMethod: expense.splitMethod,
    blockId: expense.blockId,
    dayId: expense.dayId,
    note: expense.note,
    receiptAssetIds: expense.receiptAssetIds ?? [],
    payments: model.payments.map((payment) => ({
      participantId: payment.participantId,
      participantName: payment.participantName,
      amountMinor: money(payment.amountMinor),
      amountBaseMinor: money(payment.amountBaseMinor),
    })),
    shares: model.shares.map((share) => ({
      participantId: share.participantId,
      participantName: share.participantName,
      shareAmountMinor: money(share.shareAmountMinor),
      shareAmountBaseMinor: money(share.shareAmountBaseMinor),
    })),
    yourShareMinor: model.yourShareMinor === null ? null : money(model.yourShareMinor),
    createdBy: expense.createdBy,
    version: Number(expense.version),
    createdAt: expense.createdAt.toISOString(),
    updatedAt: expense.updatedAt.toISOString(),
  };
}

export function toBalancesResponse(result: {
  baseCurrency: string;
  totalSpentMinor: bigint;
  isFullySettled: boolean;
  balances: readonly BalanceRow[];
}) {
  return {
    baseCurrency: result.baseCurrency,
    totalSpentMinor: money(result.totalSpentMinor),
    isFullySettled: result.isFullySettled,
    balances: result.balances.map((row) => ({
      participantId: row.participantId,
      displayName: row.displayName,
      isPlaceholder: row.isPlaceholder,
      paidMinor: money(row.paidMinor),
      owedMinor: money(row.owedMinor),
      settlementsSentMinor: money(row.sentMinor),
      settlementsReceivedMinor: money(row.receivedMinor),
      netMinor: money(row.netMinor),
    })),
  };
}

export function toSettleUpResponse(
  baseCurrency: string,
  result: { simplified: boolean; transfers: readonly Transfer[] },
) {
  return {
    baseCurrency,
    simplified: result.simplified,
    transfers: result.transfers.map((transfer) => ({
      fromParticipantId: transfer.fromParticipantId,
      fromName: transfer.fromName,
      toParticipantId: transfer.toParticipantId,
      toName: transfer.toName,
      amountMinor: money(transfer.amountMinor),
      payeeUpiId: transfer.payeeUpiId,
      upiDeepLink: transfer.upiDeepLink,
    })),
  };
}

export function toSettlementDTO(row: SettlementRow & { fromName: string; toName: string }) {
  return {
    id: row.id,
    tripId: row.tripId,
    fromParticipantId: row.fromParticipantId,
    fromName: row.fromName,
    toParticipantId: row.toParticipantId,
    toName: row.toName,
    amountMinor: money(row.amountMinor),
    currency: row.currency,
    method: row.method,
    note: row.note,
    settledAt: row.settledAt.toISOString(),
    recordedBy: row.recordedBy,
    confirmedByPayee: row.confirmedByPayee,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
  };
}
