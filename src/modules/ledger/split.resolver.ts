/**
 * Turn a client `SplitInput` into concrete shares in both currencies.
 *
 * This is the bridge between the API contract and the pure money layer, and it
 * is deliberately a standalone pure function: no database, no request, no
 * services. That makes every split method exhaustively unit-testable, which is
 * the point given PRD §15.4.
 */

import type { SplitInput } from '../../contracts/ledger';
import {
  allocate,
  allocateBoth,
  allocateWithAdjustments,
  sumAllocation,
  type Weight,
} from '../../money/index';
import { DomainRuleError, SharesMismatchError } from '../../platform/errors/AppError';

export interface ResolvedShare {
  readonly participantId: string;
  readonly shareAmountMinor: bigint;
  readonly shareAmountBaseMinor: bigint;
  readonly shareInput: string | null;
}

export interface ResolveSplitArgs {
  readonly split: SplitInput;
  readonly totalMinor: bigint;
  readonly totalBaseMinor: bigint;
  readonly currency: string;
  /** Participant ids that actually belong to this trip's ledger. */
  readonly validParticipantIds: ReadonlySet<string>;
}

function assertParticipantsBelong(
  ids: readonly string[],
  valid: ReadonlySet<string>,
): void {
  const unknown = ids.filter((id) => !valid.has(id));
  if (unknown.length > 0) {
    throw new DomainRuleError('Some people in this split are not on the trip', {
      unknownParticipantIds: unknown,
    });
  }
  if (new Set(ids).size !== ids.length) {
    throw new DomainRuleError('The same person appears more than once in the split');
  }
}

/**
 * PERCENT weights.
 *
 * Percentages arrive as decimals (e.g. 33.5). They are scaled to integers so
 * the allocation stays in exact integer arithmetic, and validated to sum to
 * 100 — the API refuses to silently absorb a difference (FR-SPLIT-11).
 */
function percentWeights(
  shares: readonly { participantId: string; percent: number }[],
): Weight[] {
  const SCALE = 1_000_000;
  let total = 0;

  const weights = shares.map(({ participantId, percent }) => {
    // Percentages arrive from JSON as floats. This is the ONE boundary where a
    // float becomes an integer, and it happens before any money is touched —
    // the scaled weight is a ratio, never an amount.
    // eslint-disable-next-line no-restricted-syntax -- scaling a ratio, not money
    const scaled = Math.round(percent * SCALE);
    total += scaled;
    return { id: participantId, weight: BigInt(scaled) };
  });

  if (total !== 100 * SCALE) {
    const off = (total / SCALE - 100).toFixed(4).replace(/\.?0+$/, '');
    throw new DomainRuleError(
      `Percentages must add up to 100% — currently ${(total / SCALE).toFixed(2)}% (off by ${off}%)`,
      { totalPercent: total / SCALE },
    );
  }

  return weights;
}

export function resolveSplit(args: ResolveSplitArgs): ResolvedShare[] {
  const { split, totalMinor, totalBaseMinor, currency, validParticipantIds } = args;

  switch (split.method) {
    case 'EQUAL': {
      assertParticipantsBelong(split.participantIds, validParticipantIds);
      const weights = split.participantIds.map((id) => ({ id, weight: 1n }));
      const { native, base } = allocateBoth(totalMinor, totalBaseMinor, weights);

      return split.participantIds.map((participantId) => ({
        participantId,
        shareAmountMinor: native.get(participantId)!,
        shareAmountBaseMinor: base.get(participantId)!,
        shareInput: null,
      }));
    }

    case 'SHARES': {
      const ids = split.shares.map((s) => s.participantId);
      assertParticipantsBelong(ids, validParticipantIds);

      const weights = split.shares.map((s) => ({
        id: s.participantId,
        weight: BigInt(s.weight),
      }));
      const { native, base } = allocateBoth(totalMinor, totalBaseMinor, weights);

      return split.shares.map((s) => ({
        participantId: s.participantId,
        shareAmountMinor: native.get(s.participantId)!,
        shareAmountBaseMinor: base.get(s.participantId)!,
        shareInput: String(s.weight),
      }));
    }

    case 'PERCENT': {
      const ids = split.shares.map((s) => s.participantId);
      assertParticipantsBelong(ids, validParticipantIds);

      const weights = percentWeights(split.shares);
      const { native, base } = allocateBoth(totalMinor, totalBaseMinor, weights);

      return split.shares.map((s) => ({
        participantId: s.participantId,
        shareAmountMinor: native.get(s.participantId)!,
        shareAmountBaseMinor: base.get(s.participantId)!,
        shareInput: s.percent.toFixed(6),
      }));
    }

    case 'ADJUSTMENT': {
      assertParticipantsBelong(split.participantIds, validParticipantIds);

      const adjustmentIds = split.adjustments.map((a) => a.participantId);
      assertParticipantsBelong(adjustmentIds, validParticipantIds);

      const nativeAdjustments = new Map(
        split.adjustments.map((a) => [a.participantId, BigInt(a.amountMinor)]),
      );

      const native = allocateWithAdjustments(
        totalMinor,
        split.participantIds,
        nativeAdjustments,
      );

      // The base-currency view must be allocated independently to stay exact.
      // Adjustments are scaled by the ratio of the two totals via the same
      // largest-remainder pass, so both sets sum to their own total.
      const adjustmentTotal = sumAllocation(nativeAdjustments);
      const baseAdjustments = new Map<string, bigint>();

      if (adjustmentTotal !== 0n && totalMinor !== 0n) {
        const scaled = allocate(
          (totalBaseMinor * adjustmentTotal) / totalMinor,
          split.adjustments.map((a) => ({
            id: a.participantId,
            // Weight by magnitude so proportions are preserved.
            weight:
              BigInt(a.amountMinor) < 0n ? -BigInt(a.amountMinor) : BigInt(a.amountMinor),
          })).filter((w) => w.weight > 0n),
        );
        for (const [id, value] of scaled) {
          const original = nativeAdjustments.get(id) ?? 0n;
          baseAdjustments.set(id, original < 0n ? -value : value);
        }
      }

      const base = allocateWithAdjustments(
        totalBaseMinor,
        split.participantIds,
        baseAdjustments,
      );

      return split.participantIds.map((participantId) => ({
        participantId,
        shareAmountMinor: native.get(participantId)!,
        shareAmountBaseMinor: base.get(participantId)!,
        shareInput: (nativeAdjustments.get(participantId) ?? 0n).toString(),
      }));
    }

    case 'EXACT': {
      const ids = split.shares.map((s) => s.participantId);
      assertParticipantsBelong(ids, validParticipantIds);

      const amounts = split.shares.map((s) => ({
        participantId: s.participantId,
        amount: BigInt(s.amountMinor),
      }));

      const sum = amounts.reduce((total, s) => total + s.amount, 0n);
      if (sum !== totalMinor) {
        // FR-SPLIT-11: never silently absorb the difference.
        throw new SharesMismatchError(totalMinor - sum, currency);
      }

      // Exact amounts define the native split; the base split is derived by
      // allocating the base total against those amounts as weights, so it also
      // sums exactly. Zero-value shares are preserved but carry no weight.
      const weighted = amounts
        .filter((a) => a.amount !== 0n)
        .map((a) => ({
          id: a.participantId,
          weight: a.amount < 0n ? -a.amount : a.amount,
        }));

      const base =
        weighted.length > 0
          ? allocate(totalBaseMinor, weighted)
          : new Map<string, bigint>();

      return amounts.map((a) => ({
        participantId: a.participantId,
        shareAmountMinor: a.amount,
        shareAmountBaseMinor:
          a.amount === 0n ? 0n : a.amount < 0n ? -(base.get(a.participantId) ?? 0n) : (base.get(a.participantId) ?? 0n),
        shareInput: a.amount.toString(),
      }));
    }

    default: {
      // Exhaustiveness: adding a split method without handling it fails to compile.
      const exhaustive: never = split;
      throw new DomainRuleError(`Unsupported split method: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Validate payments and allocate their base-currency counterparts.
 *
 * Payments must sum to the expense total (FR-SPLIT-13 keeps this a collection
 * even though v1's UI creates a single row).
 */
export function resolvePayments(
  payments: readonly { participantId: string; amountMinor: string }[],
  totalMinor: bigint,
  totalBaseMinor: bigint,
  currency: string,
  validParticipantIds: ReadonlySet<string>,
): { participantId: string; amountMinor: bigint; amountBaseMinor: bigint }[] {
  const ids = payments.map((p) => p.participantId);
  assertParticipantsBelong(ids, validParticipantIds);

  const parsed = payments.map((p) => ({
    participantId: p.participantId,
    amount: BigInt(p.amountMinor),
  }));

  const sum = parsed.reduce((total, p) => total + p.amount, 0n);
  if (sum !== totalMinor) {
    throw new SharesMismatchError(totalMinor - sum, currency);
  }

  if (parsed.length === 1) {
    // Single payer: the whole base total, no allocation needed.
    return [
      {
        participantId: parsed[0]!.participantId,
        amountMinor: parsed[0]!.amount,
        amountBaseMinor: totalBaseMinor,
      },
    ];
  }

  const base = allocate(
    totalBaseMinor,
    parsed
      .filter((p) => p.amount !== 0n)
      .map((p) => ({ id: p.participantId, weight: p.amount < 0n ? -p.amount : p.amount })),
  );

  return parsed.map((p) => ({
    participantId: p.participantId,
    amountMinor: p.amount,
    amountBaseMinor:
      p.amount === 0n ? 0n : p.amount < 0n ? -(base.get(p.participantId) ?? 0n) : (base.get(p.participantId) ?? 0n),
  }));
}
