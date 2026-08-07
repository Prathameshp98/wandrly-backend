import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  convertMinor,
  divRound,
  formatMinor,
  formatRate,
  parseMinor,
  parseRate,
} from './currency';

describe('divRound', () => {
  it('rounds half away from zero', () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(4n, 2n)).toBe(2n);
    expect(divRound(1n, 3n)).toBe(0n);
    expect(divRound(2n, 3n)).toBe(1n);
  });

  it('is symmetric around zero', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1_000_000n, max: 1_000_000n }),
        fc.bigInt({ min: 1n, max: 1_000n }),
        (num, den) => {
          expect(divRound(-num, den)).toBe(-divRound(num, den));
        },
      ),
    );
  });

  it('rejects division by zero', () => {
    expect(() => divRound(1n, 0n)).toThrow(/division by zero/);
  });
});

describe('parseRate / formatRate', () => {
  it('round-trips', () => {
    for (const rate of ['1', '0.58', '83.12345678', '0.00000001']) {
      expect(Number(formatRate(parseRate(rate)))).toBeCloseTo(Number(rate), 8);
    }
  });

  it('scales to 8 decimal places', () => {
    expect(parseRate('1')).toBe(100_000_000n);
    expect(parseRate('0.58')).toBe(58_000_000n);
  });

  it('rejects nonsense', () => {
    for (const bad of ['', 'abc', '-1.5', '0', '1.2.3', 'NaN']) {
      expect(() => parseRate(bad)).toThrow();
    }
  });
});

describe('convertMinor', () => {
  it('accounts for differing currency exponents', () => {
    // ¥10,000 (JPY, 0dp → 10000 minor) at 0.58 → ₹5,800 = 580000 paise.
    // Getting the exponent shift wrong understates this by 100×.
    expect(convertMinor(10_000n, parseRate('0.58'), 'JPY', 'INR')).toBe(580_000n);
  });

  it('handles the reverse direction', () => {
    // ₹580,000 paise at ¥1.724137 per ₹1 → ¥10,000 (no decimals).
    expect(convertMinor(580_000n, parseRate('1.72413793'), 'INR', 'JPY')).toBe(10_000n);
  });

  it('is identity for the same currency at rate 1', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -1_000_000n, max: 1_000_000n }), (amount) => {
        expect(convertMinor(amount, parseRate('1'), 'INR', 'INR')).toBe(amount);
      }),
    );
  });

  it('handles three-decimal currencies', () => {
    // 1 BHD = 1000 minor units (3dp). At ₹220/BHD that is ₹220 = 22,000 paise.
    expect(convertMinor(1_000n, parseRate('220'), 'BHD', 'INR')).toBe(22_000n);
    // …and 1000 BHD = 1,000,000 minor units → ₹220,000 = 22,000,000 paise.
    expect(convertMinor(1_000_000n, parseRate('220'), 'BHD', 'INR')).toBe(22_000_000n);
  });

  it('preserves sign for refunds', () => {
    expect(convertMinor(-10_000n, parseRate('0.58'), 'JPY', 'INR')).toBe(-580_000n);
  });

  it('rejects a non-positive rate', () => {
    expect(() => convertMinor(100n, 0n, 'INR', 'USD')).toThrow(/must be positive/);
  });
});

describe('parseMinor / formatMinor', () => {
  it('round-trips across currencies', () => {
    const cases: [string, string][] = [
      ['INR', '1234.56'],
      ['JPY', '86400'],
      ['BHD', '12.345'],
      ['USD', '0.01'],
    ];
    for (const [currency, value] of cases) {
      expect(formatMinor(parseMinor(value, currency), currency)).toBe(value);
    }
  });

  it('rejects more precision than the currency supports', () => {
    expect(() => parseMinor('100.5', 'JPY')).toThrow(/supports 0 decimal/);
    expect(() => parseMinor('1.234', 'INR')).toThrow(/supports 2 decimal/);
    expect(parseMinor('1.234', 'BHD')).toBe(1_234n);
  });

  it('formats negatives correctly', () => {
    expect(formatMinor(-123_456n, 'INR')).toBe('-1234.56');
    expect(formatMinor(-500n, 'JPY')).toBe('-500');
  });
});
