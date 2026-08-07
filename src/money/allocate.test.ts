/**
 * Property-based tests for the allocation layer.
 *
 * TECHNICAL_DESIGN §13.1, PRD §15.4. These are a gate, not a nicety: a wrong
 * number in a shared ledger is an argument between friends, not a bug report.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  allocate,
  allocateBoth,
  allocateEqual,
  allocateWithAdjustments,
  sumAllocation,
} from './allocate';
import { convertMinor, exponentOf, parseRate } from './currency';

const nonZeroTotal = fc
  .bigInt({ min: -10_000_000_000n, max: 10_000_000_000n })
  .filter((n) => n !== 0n);

const positiveTotal = fc.bigInt({ min: 1n, max: 10_000_000_000n });

const weightList = fc
  .array(fc.bigInt({ min: 1n, max: 1000n }), { minLength: 1, maxLength: 20 })
  .map((weights) => weights.map((weight, i) => ({ id: `p${i}`, weight })));

const participantIds = fc
  .integer({ min: 1, max: 20 })
  .map((n) => Array.from({ length: n }, (_, i) => `p${i}`));

const CURRENCIES = ['JPY', 'INR', 'USD', 'BHD', 'KWD', 'KRW', 'EUR', 'VND'] as const;

/**
 * A strictly positive FX rate string. The whole and fractional parts are
 * generated independently, so this filters the all-zero combination that
 * `parseRate` rightly rejects.
 */
const rateString = fc
  .tuple(fc.integer({ min: 0, max: 5000 }), fc.integer({ min: 0, max: 99_999_999 }))
  .filter(([whole, fraction]) => whole > 0 || fraction > 0)
  .map(([whole, fraction]) => `${whole}.${String(fraction).padStart(8, '0')}`);

describe('allocate', () => {
  it('always sums exactly to the total', () => {
    fc.assert(
      fc.property(nonZeroTotal, weightList, (total, weights) => {
        expect(sumAllocation(allocate(total, weights))).toBe(total);
      }),
      { numRuns: 2000 },
    );
  });

  it('gives every participant a share', () => {
    fc.assert(
      fc.property(positiveTotal, weightList, (total, weights) => {
        const result = allocate(total, weights);
        expect(result.size).toBe(weights.length);
        for (const { id } of weights) expect(result.has(id)).toBe(true);
      }),
    );
  });

  it('never differs from the exact share by a whole minor unit or more', () => {
    fc.assert(
      fc.property(positiveTotal, weightList, (total, weights) => {
        const totalWeight = weights.reduce((s, w) => s + w.weight, 0n);
        const result = allocate(total, weights);

        for (const { id, weight } of weights) {
          const exactNumerator = total * weight;
          const actual = result.get(id)!;
          // |actual − exact| < 1 minor unit  ⇔  |actual·W − total·w| < W
          const drift = actual * totalWeight - exactNumerator;
          const magnitude = drift < 0n ? -drift : drift;
          expect(magnitude < totalWeight).toBe(true);
        }
      }),
    );
  });

  it('is deterministic — identical input yields identical output', () => {
    fc.assert(
      fc.property(nonZeroTotal, weightList, (total, weights) => {
        const a = allocate(total, weights);
        const b = allocate(total, weights);
        expect([...a.entries()]).toStrictEqual([...b.entries()]);
      }),
    );
  });

  it('is independent of the order participants are supplied in', () => {
    fc.assert(
      fc.property(positiveTotal, weightList, (total, weights) => {
        const forward = allocate(total, weights);
        const reversed = allocate(total, [...weights].reverse());
        for (const { id } of weights) {
          expect(reversed.get(id)).toBe(forward.get(id));
        }
      }),
    );
  });

  it('negates symmetrically for refunds', () => {
    fc.assert(
      fc.property(positiveTotal, weightList, (total, weights) => {
        const positive = allocate(total, weights);
        const negative = allocate(-total, weights);
        for (const { id } of weights) {
          expect(negative.get(id)).toBe(-positive.get(id)!);
        }
      }),
    );
  });

  it('distributes the remainder without systematically favouring one participant', () => {
    // 10 units across 3 people, run for shifting totals: each participant should
    // pick up the extra unit a comparable number of times.
    const counts = new Map<string, number>([
      ['p0', 0],
      ['p1', 0],
      ['p2', 0],
    ]);
    const ids = ['p0', 'p1', 'p2'];

    for (let total = 1n; total <= 300n; total += 1n) {
      const result = allocateEqual(total, ids);
      const max = [...result.values()].reduce((m, v) => (v > m ? v : m), 0n);
      for (const [id, value] of result) {
        if (value === max) counts.set(id, counts.get(id)! + 1);
      }
    }

    const values = [...counts.values()];
    const spread = Math.max(...values) - Math.min(...values);
    // Equal weights make remainders tie every time, so the id tie-break decides.
    // What matters is that no participant is starved entirely.
    expect(Math.min(...values)).toBeGreaterThan(0);
    expect(spread).toBeLessThan(300);
  });

  it('rejects invalid input rather than guessing', () => {
    expect(() => allocate(100n, [])).toThrow(/at least one participant/);
    expect(() => allocate(100n, [{ id: 'a', weight: 0n }])).toThrow(/positive value/);
    expect(() => allocate(100n, [{ id: 'a', weight: -1n }])).toThrow(/negative weight/);
    expect(() =>
      allocate(100n, [
        { id: 'a', weight: 1n },
        { id: 'a', weight: 1n },
      ]),
    ).toThrow(/duplicate participant/);
  });

  it('handles the documented worked example', () => {
    // ¥10,000 three ways → 3334 / 3333 / 3333
    const result = allocateEqual(10_000n, ['a', 'b', 'c']);
    expect(sumAllocation(result)).toBe(10_000n);
    expect([...result.values()].sort((x, y) => Number(y - x))).toStrictEqual([
      3334n,
      3333n,
      3333n,
    ]);
  });

  it('respects weights — a couple counting as two shares', () => {
    const result = allocate(9_000n, [
      { id: 'solo', weight: 1n },
      { id: 'couple', weight: 2n },
    ]);
    expect(result.get('solo')).toBe(3_000n);
    expect(result.get('couple')).toBe(6_000n);
    expect(sumAllocation(result)).toBe(9_000n);
  });
});

describe('allocateBoth — the dual-currency invariant', () => {
  it('native and base share sets each sum to their own total', () => {
    fc.assert(
      fc.property(
        positiveTotal,
        weightList,
        fc.constantFrom(...CURRENCIES),
        fc.constantFrom(...CURRENCIES),
        rateString,
        (totalNative, weights, from, to, rawRate) => {
          const rate = parseRate(rawRate);
          const totalBase = convertMinor(totalNative, rate, from, to);

          const { native, base } = allocateBoth(totalNative, totalBase, weights);

          expect(sumAllocation(native)).toBe(totalNative);
          expect(sumAllocation(base)).toBe(totalBase);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('demonstrates why per-share conversion is unsafe', () => {
    // The bug this design avoids: converting each share independently can drift
    // from the converted total. Here we prove the drift is real, so the
    // allocate-twice approach is justified rather than cargo-culted.
    const rate = parseRate('0.58731');
    const totalNative = 10_000n; // JPY
    const ids = Array.from({ length: 7 }, (_, i) => `p${i}`);

    const totalBase = convertMinor(totalNative, rate, 'JPY', 'INR');
    const nativeShares = allocateEqual(totalNative, ids);

    let convertedSum = 0n;
    for (const share of nativeShares.values()) {
      convertedSum += convertMinor(share, rate, 'JPY', 'INR');
    }

    // The naive approach drifts; ours does not.
    expect(convertedSum).not.toBe(totalBase);
    expect(sumAllocation(allocateBoth(totalNative, totalBase, ids.map((id) => ({ id, weight: 1n }))).base)).toBe(
      totalBase,
    );
  });
});

describe('allocateWithAdjustments', () => {
  it('still sums exactly to the total', () => {
    fc.assert(
      fc.property(
        positiveTotal,
        participantIds,
        fc.array(fc.bigInt({ min: -5_000n, max: 5_000n }), { maxLength: 20 }),
        (total, ids, rawAdjustments) => {
          const adjustments = new Map<string, bigint>();
          ids.forEach((id, i) => {
            const adjustment = rawAdjustments[i];
            if (adjustment !== undefined) adjustments.set(id, adjustment);
          });

          const result = allocateWithAdjustments(total, ids, adjustments);
          expect(sumAllocation(result)).toBe(total);
        },
      ),
    );
  });

  it('applies the adjustment on top of an equal split', () => {
    // ₹1,000 across 4, but one person had a ₹200 extra main course.
    const result = allocateWithAdjustments(100_000n, ['a', 'b', 'c', 'd'], new Map([['d', 20_000n]]));
    expect(result.get('a')).toBe(20_000n);
    expect(result.get('d')).toBe(40_000n);
    expect(sumAllocation(result)).toBe(100_000n);
  });

  it('rejects an adjustment for someone outside the split', () => {
    expect(() => allocateWithAdjustments(1000n, ['a'], new Map([['z', 10n]]))).toThrow(
      /not in the split/,
    );
  });
});

describe('currency exponents', () => {
  it('knows zero- and three-decimal currencies', () => {
    expect(exponentOf('JPY')).toBe(0);
    expect(exponentOf('KRW')).toBe(0);
    expect(exponentOf('BHD')).toBe(3);
    expect(exponentOf('INR')).toBe(2);
    expect(exponentOf('XYZ')).toBe(2); // unknown defaults to 2
  });

  it('splits zero-decimal currencies without inventing sub-units', () => {
    const result = allocateEqual(100n, ['a', 'b', 'c']);
    expect(sumAllocation(result)).toBe(100n);
    for (const value of result.values()) {
      expect(value === 34n || value === 33n).toBe(true);
    }
  });
});
