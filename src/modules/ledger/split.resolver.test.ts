/**
 * Split resolution — every method, in both currencies.
 *
 * The invariant under test, for all five split methods:
 *   sum(shareAmountMinor)     === totalMinor
 *   sum(shareAmountBaseMinor) === totalBaseMinor
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { convertMinor, parseRate } from '../../money/index';
import { DomainRuleError, SharesMismatchError } from '../../platform/errors/AppError';
import { resolvePayments, resolveSplit } from './split.resolver';

const P = ['p1', 'p2', 'p3', 'p4'];
const VALID = new Set(P);

const sums = (shares: { shareAmountMinor: bigint; shareAmountBaseMinor: bigint }[]) => ({
  native: shares.reduce((s, x) => s + x.shareAmountMinor, 0n),
  base: shares.reduce((s, x) => s + x.shareAmountBaseMinor, 0n),
});

describe('resolveSplit — EQUAL', () => {
  it('sums exactly in both currencies', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 100_000_000n }),
        fc.integer({ min: 1, max: 4 }),
        (totalMinor, count) => {
          const ids = P.slice(0, count);
          const totalBaseMinor = convertMinor(totalMinor, parseRate('0.58731'), 'JPY', 'INR');

          const shares = resolveSplit({
            split: { method: 'EQUAL', participantIds: ids },
            totalMinor,
            totalBaseMinor,
            currency: 'JPY',
            validParticipantIds: VALID,
          });

          const { native, base } = sums(shares);
          expect(native).toBe(totalMinor);
          expect(base).toBe(totalBaseMinor);
          expect(shares).toHaveLength(count);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('resolveSplit — SHARES', () => {
  it('sums exactly and respects weights', () => {
    const shares = resolveSplit({
      split: {
        method: 'SHARES',
        shares: [
          { participantId: 'p1', weight: 1 },
          { participantId: 'p2', weight: 2 },
        ],
      },
      totalMinor: 9_000n,
      totalBaseMinor: 5_286n,
      currency: 'JPY',
      validParticipantIds: VALID,
    });

    expect(sums(shares).native).toBe(9_000n);
    expect(sums(shares).base).toBe(5_286n);
    expect(shares.find((s) => s.participantId === 'p2')!.shareAmountMinor).toBe(6_000n);
  });

  it('sums exactly for arbitrary weights', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 4 }),
        (totalMinor, weights) => {
          const totalBaseMinor = convertMinor(totalMinor, parseRate('83.4212'), 'USD', 'INR');
          const shares = resolveSplit({
            split: {
              method: 'SHARES',
              shares: weights.map((weight, i) => ({ participantId: P[i]!, weight })),
            },
            totalMinor,
            totalBaseMinor,
            currency: 'USD',
            validParticipantIds: VALID,
          });

          expect(sums(shares).native).toBe(totalMinor);
          expect(sums(shares).base).toBe(totalBaseMinor);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('resolveSplit — PERCENT', () => {
  it('accepts percentages that total 100', () => {
    const shares = resolveSplit({
      split: {
        method: 'PERCENT',
        shares: [
          { participantId: 'p1', percent: 60 },
          { participantId: 'p2', percent: 40 },
        ],
      },
      totalMinor: 10_000n,
      totalBaseMinor: 5_873n,
      currency: 'JPY',
      validParticipantIds: VALID,
    });

    expect(shares.find((s) => s.participantId === 'p1')!.shareAmountMinor).toBe(6_000n);
    expect(sums(shares).native).toBe(10_000n);
    expect(sums(shares).base).toBe(5_873n);
  });

  it('handles fractional percentages that still total 100', () => {
    const shares = resolveSplit({
      split: {
        method: 'PERCENT',
        shares: [
          { participantId: 'p1', percent: 33.33 },
          { participantId: 'p2', percent: 33.33 },
          { participantId: 'p3', percent: 33.34 },
        ],
      },
      totalMinor: 100_000n,
      totalBaseMinor: 58_731n,
      currency: 'JPY',
      validParticipantIds: VALID,
    });

    expect(sums(shares).native).toBe(100_000n);
    expect(sums(shares).base).toBe(58_731n);
  });

  it('rejects percentages that do not total 100, reporting the gap', () => {
    expect(() =>
      resolveSplit({
        split: {
          method: 'PERCENT',
          shares: [
            { participantId: 'p1', percent: 50 },
            { participantId: 'p2', percent: 30 },
          ],
        },
        totalMinor: 1_000n,
        totalBaseMinor: 587n,
        currency: 'JPY',
        validParticipantIds: VALID,
      }),
    ).toThrow(/add up to 100%/);
  });
});

describe('resolveSplit — ADJUSTMENT', () => {
  it('sums exactly in both currencies', () => {
    const shares = resolveSplit({
      split: {
        method: 'ADJUSTMENT',
        participantIds: ['p1', 'p2', 'p3', 'p4'],
        adjustments: [{ participantId: 'p4', amountMinor: '20000' }],
      },
      totalMinor: 100_000n,
      totalBaseMinor: 58_731n,
      currency: 'JPY',
      validParticipantIds: VALID,
    });

    expect(sums(shares).native).toBe(100_000n);
    expect(sums(shares).base).toBe(58_731n);
    // The adjusted person pays their equal share plus the adjustment.
    expect(shares.find((s) => s.participantId === 'p4')!.shareAmountMinor).toBe(40_000n);
    expect(shares.find((s) => s.participantId === 'p1')!.shareAmountMinor).toBe(20_000n);
  });

  it('sums exactly with no adjustments (degenerates to EQUAL)', () => {
    const shares = resolveSplit({
      split: { method: 'ADJUSTMENT', participantIds: ['p1', 'p2', 'p3'], adjustments: [] },
      totalMinor: 10_000n,
      totalBaseMinor: 5_873n,
      currency: 'JPY',
      validParticipantIds: VALID,
    });
    expect(sums(shares).native).toBe(10_000n);
    expect(sums(shares).base).toBe(5_873n);
  });

  it('sums exactly across random adjustments', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 10_000n, max: 10_000_000n }),
        fc.array(fc.bigInt({ min: -1_000n, max: 1_000n }), { minLength: 1, maxLength: 4 }),
        (totalMinor, adjustments) => {
          const ids = P.slice(0, adjustments.length);
          const totalBaseMinor = convertMinor(totalMinor, parseRate('0.58731'), 'JPY', 'INR');

          const shares = resolveSplit({
            split: {
              method: 'ADJUSTMENT',
              participantIds: ids,
              adjustments: adjustments.map((amount, i) => ({
                participantId: ids[i]!,
                amountMinor: amount.toString(),
              })),
            },
            totalMinor,
            totalBaseMinor,
            currency: 'JPY',
            validParticipantIds: VALID,
          });

          expect(sums(shares).native).toBe(totalMinor);
          expect(sums(shares).base).toBe(totalBaseMinor);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('resolveSplit — EXACT', () => {
  it('accepts amounts that sum to the total', () => {
    const shares = resolveSplit({
      split: {
        method: 'EXACT',
        shares: [
          { participantId: 'p1', amountMinor: '7000' },
          { participantId: 'p2', amountMinor: '3000' },
        ],
      },
      totalMinor: 10_000n,
      totalBaseMinor: 5_873n,
      currency: 'JPY',
      validParticipantIds: VALID,
    });

    expect(sums(shares).native).toBe(10_000n);
    expect(sums(shares).base).toBe(5_873n);
  });

  it('rejects a short split and reports the exact gap', () => {
    try {
      resolveSplit({
        split: {
          method: 'EXACT',
          shares: [
            { participantId: 'p1', amountMinor: '4000' },
            { participantId: 'p2', amountMinor: '4000' },
          ],
        },
        totalMinor: 10_000n,
        totalBaseMinor: 5_873n,
        currency: 'JPY',
        validParticipantIds: VALID,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SharesMismatchError);
      expect((error as SharesMismatchError).details).toMatchObject({
        differenceMinor: '2000',
        currency: 'JPY',
      });
    }
  });

  it('permits a zero share for someone included but not charged', () => {
    const shares = resolveSplit({
      split: {
        method: 'EXACT',
        shares: [
          { participantId: 'p1', amountMinor: '10000' },
          { participantId: 'p2', amountMinor: '0' },
        ],
      },
      totalMinor: 10_000n,
      totalBaseMinor: 5_873n,
      currency: 'JPY',
      validParticipantIds: VALID,
    });

    expect(shares.find((s) => s.participantId === 'p2')!.shareAmountBaseMinor).toBe(0n);
    expect(sums(shares).base).toBe(5_873n);
  });
});

describe('participant validation', () => {
  it('rejects a participant from another trip', () => {
    expect(() =>
      resolveSplit({
        split: { method: 'EQUAL', participantIds: ['intruder'] },
        totalMinor: 100n,
        totalBaseMinor: 100n,
        currency: 'INR',
        validParticipantIds: VALID,
      }),
    ).toThrow(DomainRuleError);
  });

  it('rejects the same participant twice', () => {
    expect(() =>
      resolveSplit({
        split: { method: 'EQUAL', participantIds: ['p1', 'p1'] },
        totalMinor: 100n,
        totalBaseMinor: 100n,
        currency: 'INR',
        validParticipantIds: VALID,
      }),
    ).toThrow(/more than once/);
  });
});

describe('resolvePayments', () => {
  it('assigns the full base total to a single payer', () => {
    const payments = resolvePayments(
      [{ participantId: 'p1', amountMinor: '10000' }],
      10_000n,
      5_873n,
      'JPY',
      VALID,
    );
    expect(payments).toHaveLength(1);
    expect(payments[0]!.amountBaseMinor).toBe(5_873n);
  });

  it('splits the base total across multiple payers exactly', () => {
    const payments = resolvePayments(
      [
        { participantId: 'p1', amountMinor: '6000' },
        { participantId: 'p2', amountMinor: '4000' },
      ],
      10_000n,
      5_873n,
      'JPY',
      VALID,
    );
    expect(payments.reduce((s, p) => s + p.amountMinor, 0n)).toBe(10_000n);
    expect(payments.reduce((s, p) => s + p.amountBaseMinor, 0n)).toBe(5_873n);
  });

  it('rejects payments that do not sum to the total', () => {
    expect(() =>
      resolvePayments(
        [{ participantId: 'p1', amountMinor: '9000' }],
        10_000n,
        5_873n,
        'JPY',
        VALID,
      ),
    ).toThrow(SharesMismatchError);
  });
});

describe('refunds (negative totals)', () => {
  it('reverses an equal split proportionally', () => {
    const shares = resolveSplit({
      split: { method: 'EQUAL', participantIds: ['p1', 'p2', 'p3'] },
      totalMinor: -9_000n,
      totalBaseMinor: -5_286n,
      currency: 'JPY',
      validParticipantIds: VALID,
    });

    expect(sums(shares).native).toBe(-9_000n);
    expect(sums(shares).base).toBe(-5_286n);
    for (const share of shares) expect(share.shareAmountMinor).toBeLessThan(0n);
  });
});
