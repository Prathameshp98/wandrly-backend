/**
 * Property-based and golden-file tests for settlement.
 *
 * TECHNICAL_DESIGN §13.1 requires a deterministic golden suite over
 * known-tricky debt graphs alongside the properties.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  LedgerImbalanceError,
  applyTransfers,
  isFullySettled,
  nettedPairwise,
  simplify,
} from './settle';

/**
 * Generate a balance set that nets to zero by construction: pick n−1 arbitrary
 * balances and make the last one absorb the residual.
 */
const balancedSet = fc
  .array(fc.bigInt({ min: -1_000_000n, max: 1_000_000n }), { minLength: 2, maxLength: 25 })
  .map((values) => {
    const balances = new Map<string, bigint>();
    let residual = 0n;
    values.forEach((value, i) => {
      balances.set(`p${i}`, value);
      residual += value;
    });
    balances.set(`p${values.length}`, -residual);
    return balances;
  });

describe('simplify', () => {
  it('clears every balance', () => {
    fc.assert(
      fc.property(balancedSet, (balances) => {
        const after = applyTransfers(balances, simplify(balances));
        expect(isFullySettled(after)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it('never needs more than n−1 transfers', () => {
    fc.assert(
      fc.property(balancedSet, (balances) => {
        const active = [...balances.values()].filter((v) => v !== 0n).length;
        const transfers = simplify(balances);
        if (active > 0) {
          expect(transfers.length).toBeLessThanOrEqual(active - 1);
        } else {
          expect(transfers).toHaveLength(0);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('only ever moves money from debtors to creditors', () => {
    fc.assert(
      fc.property(balancedSet, (balances) => {
        for (const transfer of simplify(balances)) {
          expect(transfer.amount).toBeGreaterThan(0n);
          expect(balances.get(transfer.from)!).toBeLessThan(0n);
          expect(balances.get(transfer.to)!).toBeGreaterThan(0n);
          expect(transfer.from).not.toBe(transfer.to);
        }
      }),
    );
  });

  it('conserves the total amount moved', () => {
    fc.assert(
      fc.property(balancedSet, (balances) => {
        const owed = [...balances.values()]
          .filter((v) => v > 0n)
          .reduce((sum, v) => sum + v, 0n);
        const moved = simplify(balances).reduce((sum, t) => sum + t.amount, 0n);
        expect(moved).toBe(owed);
      }),
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(balancedSet, (balances) => {
        expect(simplify(balances)).toStrictEqual(simplify(balances));
      }),
    );
  });

  it('refuses an unbalanced ledger rather than advising wrongly', () => {
    const broken = new Map([
      ['a', 100n],
      ['b', -99n],
    ]);
    expect(() => simplify(broken)).toThrow(LedgerImbalanceError);
    expect(() => simplify(broken)).toThrow(/do not net to zero/);
  });

  it('returns nothing for an already-settled ledger', () => {
    expect(simplify(new Map([['a', 0n], ['b', 0n]]))).toHaveLength(0);
    expect(simplify(new Map())).toHaveLength(0);
  });
});

describe('simplify — golden cases', () => {
  const golden: { name: string; balances: Map<string, bigint>; expected: number }[] = [
    {
      name: 'one payer covers everyone',
      balances: new Map([
        ['arjun', 30_000n],
        ['priya', -10_000n],
        ['sana', -10_000n],
        ['devon', -10_000n],
      ]),
      expected: 3,
    },
    {
      name: 'a clean cycle collapses entirely',
      // a owes b, b owes c, c owes a — all equal, so nobody owes anything.
      balances: new Map([
        ['a', 0n],
        ['b', 0n],
        ['c', 0n],
      ]),
      expected: 0,
    },
    {
      name: 'mutual debts net to a single transfer',
      balances: new Map([
        ['a', -5_000n],
        ['b', 5_000n],
      ]),
      expected: 1,
    },
    {
      name: 'participants with no activity are ignored',
      balances: new Map([
        ['a', -1_000n],
        ['b', 1_000n],
        ['idle', 0n],
      ]),
      expected: 1,
    },
    {
      name: 'uneven amounts still resolve in at most n−1',
      balances: new Map([
        ['a', -7_331n],
        ['b', -2_669n],
        ['c', 4_000n],
        ['d', 6_000n],
      ]),
      expected: 3,
    },
    {
      name: 'large group, single creditor',
      balances: new Map([
        ['payer', 99_999n],
        ['a', -33_333n],
        ['b', -33_333n],
        ['c', -33_333n],
      ]),
      expected: 3,
    },
  ];

  for (const { name, balances, expected } of golden) {
    it(name, () => {
      const transfers = simplify(balances);
      expect(transfers).toHaveLength(expected);
      expect(isFullySettled(applyTransfers(balances, transfers))).toBe(true);
    });
  }

  it('produces the expected transfer set for the canonical Kyoto case', () => {
    // Arjun fronted the ryokan; the other three owe an equal share.
    const balances = new Map([
      ['arjun', 64_800n],
      ['priya', -21_600n],
      ['sana', -21_600n],
      ['devon', -21_600n],
    ]);

    expect(simplify(balances)).toStrictEqual([
      { from: 'devon', to: 'arjun', amount: 21_600n },
      { from: 'priya', to: 'arjun', amount: 21_600n },
      { from: 'sana', to: 'arjun', amount: 21_600n },
    ]);
  });
});

describe('nettedPairwise', () => {
  it('nets mutual obligations into one direction', () => {
    const transfers = nettedPairwise([
      { from: 'a', to: 'b', amount: 500n },
      { from: 'b', to: 'a', amount: 200n },
    ]);
    expect(transfers).toStrictEqual([{ from: 'a', to: 'b', amount: 300n }]);
  });

  it('drops fully offsetting pairs', () => {
    expect(
      nettedPairwise([
        { from: 'a', to: 'b', amount: 500n },
        { from: 'b', to: 'a', amount: 500n },
      ]),
    ).toHaveLength(0);
  });

  it('ignores self-debts and zero amounts', () => {
    expect(
      nettedPairwise([
        { from: 'a', to: 'a', amount: 100n },
        { from: 'a', to: 'b', amount: 0n },
      ]),
    ).toHaveLength(0);
  });

  it('keeps distinct pairs separate rather than simplifying across them', () => {
    const transfers = nettedPairwise([
      { from: 'a', to: 'b', amount: 100n },
      { from: 'b', to: 'c', amount: 100n },
    ]);
    // The point of pairwise mode: b pays c even though a could pay c directly.
    expect(transfers).toHaveLength(2);
  });
});
