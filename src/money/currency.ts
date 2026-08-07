/**
 * Currency metadata and minor-unit arithmetic primitives.
 *
 * TECHNICAL_DESIGN §6.1, FR-SPLIT-16, FR-SPLIT-22.
 *
 * This module is intentionally dependency-free. Nothing here knows about
 * Postgres, Express, or the domain model — which is what makes it exhaustively
 * testable in isolation.
 */

/** Number of decimal places a currency subdivides into. FR-SPLIT-22. */
const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  // zero-decimal
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // three-decimal
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
});

/** Everything not listed above subdivides into 100. */
const DEFAULT_EXPONENT = 2;

/** Scale used to represent FX rates as integers. */
export const RATE_SCALE = 8;
const RATE_SCALE_FACTOR = 10n ** BigInt(RATE_SCALE);

const CURRENCY_CODE = /^[A-Z]{3}$/;

export function isValidCurrency(code: string): boolean {
  return CURRENCY_CODE.test(code);
}

export function assertCurrency(code: string): void {
  if (!isValidCurrency(code)) {
    throw new RangeError(`Invalid ISO 4217 currency code: ${JSON.stringify(code)}`);
  }
}

/** Decimal places for a currency. Unknown codes assume 2. */
export function exponentOf(currency: string): number {
  assertCurrency(currency);
  return CURRENCY_EXPONENTS[currency] ?? DEFAULT_EXPONENT;
}

function pow10(n: number): bigint {
  if (n < 0) throw new RangeError(`pow10 requires a non-negative exponent, got ${n}`);
  return 10n ** BigInt(n);
}

/**
 * Integer division rounding half away from zero.
 *
 * Half-away-from-zero (not banker's rounding) is deliberate: it matches what a
 * person doing the arithmetic by hand expects, and any bias it introduces is
 * corrected by the largest-remainder allocation in `allocate()`.
 */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('divRound: division by zero');

  let num = numerator;
  let den = denominator;
  if (den < 0n) {
    num = -num;
    den = -den;
  }

  const negative = num < 0n;
  const magnitude = negative ? -num : num;
  const quotient = magnitude / den;
  const remainder = magnitude % den;
  const rounded = remainder * 2n >= den ? quotient + 1n : quotient;

  return negative ? -rounded : rounded;
}

/**
 * Parse a decimal FX rate string into a scaled integer.
 *
 * Rates arrive from providers and from user overrides as decimal strings. They
 * are never held as JS `number` — see FR-SPLIT-16.
 */
export function parseRate(rate: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(rate.trim());
  if (!match) throw new RangeError(`Invalid FX rate: ${JSON.stringify(rate)}`);

  const [, sign, whole = '0', fraction = ''] = match;
  if (sign === '-') throw new RangeError(`FX rate must be positive: ${rate}`);

  const padded = fraction.padEnd(RATE_SCALE, '0').slice(0, RATE_SCALE);
  const scaled = BigInt(whole) * RATE_SCALE_FACTOR + BigInt(padded || '0');
  if (scaled === 0n) throw new RangeError('FX rate must be greater than zero');

  return scaled;
}

/** Render a scaled rate back to a decimal string, for storage and display. */
export function formatRate(scaledRate: bigint): string {
  const whole = scaledRate / RATE_SCALE_FACTOR;
  const fraction = (scaledRate % RATE_SCALE_FACTOR).toString().padStart(RATE_SCALE, '0');
  return `${whole}.${fraction}`;
}

/**
 * Convert an amount between currencies, in minor units throughout.
 *
 * Crucially this accounts for differing exponents. ¥10,000 is `10000` minor
 * units (JPY has no decimals); the same value in INR is `580000` paise, not
 * `5800`. Getting this wrong understates foreign expenses by 100×.
 *
 *   result = amount × rate × 10^(toExponent − fromExponent)
 */
export function convertMinor(
  amountMinor: bigint,
  scaledRate: bigint,
  fromCurrency: string,
  toCurrency: string,
): bigint {
  if (scaledRate <= 0n) throw new RangeError('convertMinor: rate must be positive');

  const fromExponent = exponentOf(fromCurrency);
  const toExponent = exponentOf(toCurrency);
  const exponentDelta = toExponent - fromExponent;

  const numerator =
    amountMinor * scaledRate * (exponentDelta > 0 ? pow10(exponentDelta) : 1n);
  const denominator =
    RATE_SCALE_FACTOR * (exponentDelta < 0 ? pow10(-exponentDelta) : 1n);

  return divRound(numerator, denominator);
}

/** Format minor units as a decimal string. Presentation only — never for math. */
export function formatMinor(amountMinor: bigint, currency: string): string {
  const exponent = exponentOf(currency);
  if (exponent === 0) return amountMinor.toString();

  const factor = pow10(exponent);
  const negative = amountMinor < 0n;
  const magnitude = negative ? -amountMinor : amountMinor;
  const whole = magnitude / factor;
  const fraction = (magnitude % factor).toString().padStart(exponent, '0');

  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Parse a decimal string into minor units for a currency.
 * Rejects more decimal places than the currency supports rather than
 * silently truncating someone's money.
 */
export function parseMinor(value: string, currency: string): bigint {
  const exponent = exponentOf(currency);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new RangeError(`Invalid amount: ${JSON.stringify(value)}`);

  const [, sign, whole = '0', fraction = ''] = match;
  if (fraction.length > exponent) {
    throw new RangeError(
      `${currency} supports ${exponent} decimal place(s); received "${value}"`,
    );
  }

  const scaled =
    BigInt(whole) * pow10(exponent) + BigInt(fraction.padEnd(exponent, '0') || '0');

  return sign === '-' ? -scaled : scaled;
}
