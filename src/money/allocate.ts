/**
 * Weighted allocation of a total across participants, using the
 * largest-remainder method.
 *
 * TECHNICAL_DESIGN §6.2, FR-SPLIT-17.
 *
 * The invariant this module exists to guarantee:
 *
 *     sum(allocate(total, weights).values()) === total     — always, exactly
 *
 * A shared ledger that loses or invents a minor unit is worse than no ledger at
 * all, because the error is invisible until two people disagree about money.
 */

export interface Weight {
  /** Stable identifier — also the tie-break key, so allocation is deterministic. */
  readonly id: string;
  readonly weight: bigint;
}

export interface AllocationPair {
  /** Shares denominated in the expense's own currency. */
  readonly native: Map<string, bigint>;
  /** Shares denominated in the trip's base currency. */
  readonly base: Map<string, bigint>;
}

/**
 * Distribute `total` across weighted participants so the parts sum exactly.
 *
 * Supports every split method in FR-SPLIT-10:
 *   EQUAL      — all weights 1
 *   SHARES     — caller-supplied weights
 *   PERCENT    — weights are percentages (they need not sum to exactly 100 here;
 *                the API layer enforces that, this function only needs ratios)
 *   ADJUSTMENT — caller removes adjustments from the total, allocates the
 *                remainder equally, then adds adjustments back
 *   EXACT      — does not use this function; amounts are supplied directly and
 *                validated to sum to the total
 *
 * Negative totals (refunds, FR-SPLIT-14) are computed on the magnitude and
 * re-signed, so rounding behaves symmetrically either side of zero.
 */
export function allocate(total: bigint, weights: readonly Weight[]): Map<string, bigint> {
  if (weights.length === 0) {
    throw new RangeError('allocate: at least one participant is required');
  }

  const seen = new Set<string>();
  for (const { id, weight } of weights) {
    if (seen.has(id)) throw new RangeError(`allocate: duplicate participant "${id}"`);
    seen.add(id);
    if (weight < 0n) throw new RangeError(`allocate: negative weight for "${id}"`);
  }

  const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0n);
  if (totalWeight <= 0n) {
    throw new RangeError('allocate: weights must sum to a positive value');
  }

  const negative = total < 0n;
  const magnitude = negative ? -total : total;

  // Integer floor division plus the exact fractional remainder, so no float
  // ever touches the calculation.
  const parts = weights.map(({ id, weight }) => {
    const numerator = magnitude * weight;
    return {
      id,
      base: numerator / totalWeight,
      remainder: numerator % totalWeight,
    };
  });

  const allocated = parts.reduce((sum, part) => sum + part.base, 0n);
  let leftover = magnitude - allocated;

  const result = new Map<string, bigint>();
  for (const part of parts) result.set(part.id, part.base);

  if (leftover > 0n) {
    // Largest remainder wins; ties broken by id so the same input always
    // produces the same output. Without this, re-saving an unchanged expense
    // could move a rupee between people and look like a bug.
    const byRemainder = [...parts].sort((a, b) => {
      if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });

    for (let i = 0; leftover > 0n; i += 1, leftover -= 1n) {
      const target = byRemainder[i % byRemainder.length]!;
      result.set(target.id, result.get(target.id)! + 1n);
    }
  }

  if (negative) {
    for (const [id, amount] of result) result.set(id, -amount);
  }

  return result;
}

/**
 * Allocate the same split in two currencies at once.
 *
 * Both share sets are produced from the same weights and therefore the same
 * tie-break order, so each sums exactly to its own total.
 *
 * This exists because deriving base-currency shares by converting each native
 * share at read time is WRONG: the sum of rounded values is not the rounded
 * sum, so `SUM(net) = 0` can break by one minor unit and silently corrupt
 * settle-up. See TECHNICAL_DESIGN §5.3.
 */
export function allocateBoth(
  totalNative: bigint,
  totalBase: bigint,
  weights: readonly Weight[],
): AllocationPair {
  return {
    native: allocate(totalNative, weights),
    base: allocate(totalBase, weights),
  };
}

/** Equal-split convenience wrapper — the default and by far the common case. */
export function allocateEqual(total: bigint, participantIds: readonly string[]): Map<string, bigint> {
  return allocate(
    total,
    participantIds.map((id) => ({ id, weight: 1n })),
  );
}

/**
 * Equal split plus a per-person adjustment (FR-SPLIT-10, ADJUSTMENT method).
 *
 * The adjustments are removed from the total, the remainder is split equally,
 * and the adjustments are added back — so the result still sums to the total.
 */
export function allocateWithAdjustments(
  total: bigint,
  participantIds: readonly string[],
  adjustments: ReadonlyMap<string, bigint>,
): Map<string, bigint> {
  for (const id of adjustments.keys()) {
    if (!participantIds.includes(id)) {
      throw new RangeError(`allocateWithAdjustments: "${id}" is not in the split`);
    }
  }

  const adjustmentTotal = [...adjustments.values()].reduce((sum, a) => sum + a, 0n);
  const remainder = total - adjustmentTotal;
  const equalShares = allocateEqual(remainder, participantIds);

  const result = new Map<string, bigint>();
  for (const id of participantIds) {
    result.set(id, equalShares.get(id)! + (adjustments.get(id) ?? 0n));
  }

  return result;
}

/** Sum an allocation. Used by the invariant assertions and by tests. */
export function sumAllocation(allocation: ReadonlyMap<string, bigint>): bigint {
  let total = 0n;
  for (const amount of allocation.values()) total += amount;
  return total;
}
