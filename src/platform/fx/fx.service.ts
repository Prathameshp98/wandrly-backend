/**
 * FX rate resolution.
 *
 * TECHNICAL_DESIGN §6.4, FR-SPLIT-19/20. The critical rule: the rate is
 * captured at expense creation and FROZEN on the row. Nothing here is ever
 * called on a read path.
 */

import { and, desc, eq } from 'drizzle-orm';

import { db, type Executor } from '../db/index';
import { fxRates } from '../db/schema/index';
import { formatRate, parseRate } from '../../money/index';
import { loggerFor } from '../logging/logger';

const log = loggerFor('fx');

export interface ResolvedRate {
  /** Decimal string, scale 8. */
  readonly rate: string;
  readonly source: 'AUTO' | 'MANUAL';
  readonly asOf: string;
}

const IDENTITY: ResolvedRate = { rate: '1.00000000', source: 'AUTO', asOf: 'identity' };

export class FxService {
  constructor(private readonly defaultExec: Executor = db) {}

  /**
   * Resolve the rate to apply to a new expense.
   *
   * Order of preference:
   *   1. A user override — card and airport rates differ materially from
   *      mid-market, and the user knows what they were actually charged.
   *   2. The most recent stored rate.
   *   3. Identity, if the currencies match.
   *
   * A missing rate never blocks the write (FR-NFR-REL-04): the expense is
   * recorded at the last known rate rather than being rejected.
   */
  async resolve(
    fromCurrency: string,
    toCurrency: string,
    override?: string,
    /**
     * MUST be the caller's transaction when called inside one. Falling back to
     * the pool here would take a second connection while the first is still
     * held, which deadlocks as soon as the pool is saturated.
     */
    exec: Executor = this.defaultExec,
  ): Promise<ResolvedRate> {
    if (override) {
      // Validates and normalises; throws on a malformed or non-positive rate.
      return {
        rate: formatRate(parseRate(override)),
        source: 'MANUAL',
        asOf: new Date().toISOString().slice(0, 10),
      };
    }

    if (fromCurrency === toCurrency) return IDENTITY;

    const stored = await this.latest(fromCurrency, toCurrency, exec);
    if (stored) return stored;

    const inverse = await this.latest(toCurrency, fromCurrency, exec);
    if (inverse) {
      // 1 / rate, computed in integer space to keep 8 decimal places.
      const scaled = parseRate(inverse.rate);
      const inverted = (10n ** 16n) / scaled;
      return { rate: formatRate(inverted), source: 'AUTO', asOf: inverse.asOf };
    }

    log.warn(
      { fromCurrency, toCurrency },
      'no FX rate available; recording expense at 1:1 and flagging',
    );
    return { rate: '1.00000000', source: 'AUTO', asOf: 'unavailable' };
  }

  private async latest(
    base: string,
    quote: string,
    exec: Executor = this.defaultExec,
  ): Promise<ResolvedRate | null> {
    const rows = await exec
      .select({ rate: fxRates.rate, asOf: fxRates.asOf })
      .from(fxRates)
      .where(and(eq(fxRates.baseCurrency, base), eq(fxRates.quoteCurrency, quote)))
      .orderBy(desc(fxRates.asOf))
      .limit(1);

    const row = rows[0];
    return row ? { rate: row.rate, source: 'AUTO', asOf: row.asOf } : null;
  }

  /** Upsert rates from the daily refresh job. */
  async store(
    base: string,
    quotes: Readonly<Record<string, string>>,
    asOf: string,
  ): Promise<number> {
    const values = Object.entries(quotes).map(([quoteCurrency, rate]) => ({
      baseCurrency: base,
      quoteCurrency,
      rate: formatRate(parseRate(rate)),
      asOf,
    }));

    if (values.length === 0) return 0;

    await this.defaultExec
      .insert(fxRates)
      .values(values)
      .onConflictDoUpdate({
        target: [fxRates.baseCurrency, fxRates.quoteCurrency, fxRates.asOf],
        set: { rate: fxRates.rate, fetchedAt: new Date() },
      });

    return values.length;
  }

  /**
   * Fetch from the provider. Open-Meteo-style: no API key required.
   * Uses exchangerate.host, which needs no signup and is free.
   */
  async refreshFromProvider(base = 'INR'): Promise<number> {
    try {
      const response = await fetch(
        `https://api.exchangerate.host/latest?base=${encodeURIComponent(base)}`,
        { signal: AbortSignal.timeout(10_000) },
      );

      if (!response.ok) {
        log.warn({ status: response.status }, 'FX provider returned an error');
        return 0;
      }

      const body = (await response.json()) as {
        rates?: Record<string, number>;
        date?: string;
      };

      if (!body.rates) return 0;

      const asOf = body.date ?? new Date().toISOString().slice(0, 10);
      const quotes = Object.fromEntries(
        Object.entries(body.rates)
          .filter(([, value]) => Number.isFinite(value) && value > 0)
          .map(([currency, value]) => [currency, value.toFixed(8)]),
      );

      const count = await this.store(base, quotes, asOf);
      log.info({ base, count, asOf }, 'FX rates refreshed');
      return count;
    } catch (error) {
      // Never let a third party break the ledger.
      log.error({ err: error }, 'FX refresh failed; existing rates remain in use');
      return 0;
    }
  }
}
