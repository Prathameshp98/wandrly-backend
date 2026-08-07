/**
 * Trip export — PDF, plain text, and calendar.
 *
 * TECHNICAL_DESIGN §10.1: PDFs are generated with `pdfkit`, NOT headless
 * Chromium. Chromium needs ~500 MB–1 GB per render and would OOM a free Koyeb
 * instance. The trade-off is that the PDF is its own designed artefact rather
 * than a screenshot of the web page.
 *
 * FR-EXP-02: booking details default OFF. They are confirmation numbers and
 * seat assignments, and an exported file leaves the product's control.
 */

import PDFDocument from 'pdfkit';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { db } from '../../platform/db/index';
import { blocks, days, trips, variants } from '../../platform/db/schema/index';
import { decryptRecord } from '../../platform/crypto/index';
import { NotFoundError } from '../../platform/errors/AppError';
import { formatMinor } from '../../money/index';
import type { TripAccess } from '../../platform/policy/index';
import { formatDateRange } from '../trips/date-utils';

export interface ExportOptions {
  readonly variantId?: string;
  readonly includeCosts: boolean;
  /** Defaults to false — see FR-EXP-02. */
  readonly includeBookings: boolean;
  readonly includeNotes: boolean;
}

interface ExportModel {
  title: string;
  destination: string;
  dateRangeLabel: string;
  variantName: string;
  days: {
    dayNumber: number;
    date: string | null;
    title: string;
    note: string;
    blocks: {
      type: string;
      title: string;
      timeLabel: string;
      startAt: Date | null;
      endAt: Date | null;
      meta: string;
      notes: string | null;
      isConfirmed: boolean;
      location: string | null;
      booking: { key: string; value: string }[] | null;
      cost: string | null;
    }[];
  }[];
}

export class ExportsService {
  /** Load exactly the data an export needs, honouring the include toggles. */
  private async model(access: TripAccess, options: ExportOptions): Promise<ExportModel> {
    const [trip] = await db
      .select()
      .from(trips)
      .where(and(eq(trips.id, access.tripId), isNull(trips.deletedAt)))
      .limit(1);

    if (!trip) throw new NotFoundError('Trip');

    // FR-EXP-07 — exports render the requested variant, defaulting to main.
    const variantId = options.variantId ?? trip.mainVariantId;
    if (!variantId) throw new NotFoundError('Variant');

    const [variant] = await db
      .select()
      .from(variants)
      .where(and(eq(variants.id, variantId), eq(variants.tripId, access.tripId)))
      .limit(1);

    if (!variant) throw new NotFoundError('Variant');

    const dayRows = await db
      .select()
      .from(days)
      .where(eq(days.variantId, variantId))
      .orderBy(asc(days.dayNumber));

    const blockRows =
      dayRows.length === 0
        ? []
        : await db
            .select()
            .from(blocks)
            .where(
              and(
                sql`${blocks.dayId} in (${sql.join(
                  dayRows.map((day) => sql`${day.id}::uuid`),
                  sql`, `,
                )})`,
                isNull(blocks.deletedAt),
              ),
            )
            .orderBy(asc(blocks.sortOrder));

    const byDay = new Map<string, typeof blockRows>();
    for (const block of blockRows) {
      const list = byDay.get(block.dayId) ?? [];
      list.push(block);
      byDay.set(block.dayId, list);
    }

    return {
      title: trip.title,
      destination: trip.destination,
      dateRangeLabel: formatDateRange(trip.startDate, trip.endDate),
      variantName: variant.name,
      days: dayRows.map((day) => ({
        dayNumber: day.dayNumber,
        date: day.date,
        title: day.title,
        note: day.note,
        blocks: (byDay.get(day.id) ?? []).map((block) => {
          const sections = (block.sections ?? {}) as Record<string, unknown>;
          const map = sections.map as { name?: string } | undefined;
          const cost = sections.cost as
            | { amountMinor: string; currency: string; per: string }
            | undefined;
          const booking = sections.booking as { key: string; value: string }[] | undefined;

          return {
            type: block.type,
            title: block.title,
            timeLabel: block.timeLabel,
            startAt: block.startAt,
            endAt: block.endAt,
            meta: block.meta,
            notes: options.includeNotes ? block.notes : null,
            isConfirmed: block.isConfirmed,
            location: map?.name ?? null,
            booking:
              options.includeBookings && booking
                ? booking.map(({ key, value }) => ({
                    key,
                    value: decryptRecord({ v: value }).v!,
                  }))
                : null,
            cost:
              options.includeCosts && cost
                ? `${cost.currency} ${formatMinor(BigInt(cost.amountMinor), cost.currency)}` +
                  (cost.per === 'pp' ? ' pp' : '')
                : null,
          };
        }),
      })),
    };
  }

  // ── Plain text (FR-EXP-04) ──────────────────────────────────────────

  /** WhatsApp-friendly: no markdown, no tables, just readable lines. */
  async toText(access: TripAccess, options: ExportOptions): Promise<string> {
    const model = await this.model(access, options);
    const lines: string[] = [
      model.title.toUpperCase(),
      `${model.destination} · ${model.dateRangeLabel}`,
      model.variantName !== 'Main' ? `Variant: ${model.variantName}` : '',
      '',
    ].filter(Boolean);

    for (const day of model.days) {
      lines.push(
        `── DAY ${String(day.dayNumber).padStart(2, '0')}${day.date ? ` · ${day.date}` : ''} ──`,
      );
      if (day.title) lines.push(day.title);
      if (day.note) lines.push(`"${day.note}"`);

      if (day.blocks.length === 0) lines.push('  (nothing planned)');

      for (const block of day.blocks) {
        const time = block.timeLabel ? `${block.timeLabel}  ` : '';
        lines.push(`  ${time}${block.title}${block.isConfirmed ? '  ✓' : ''}`);
        if (block.meta) lines.push(`      ${block.meta}`);
        if (block.location) lines.push(`      @ ${block.location}`);
        if (block.notes) lines.push(`      ${block.notes}`);
        if (block.cost) lines.push(`      ${block.cost}`);
        for (const entry of block.booking ?? []) {
          lines.push(`      ${entry.key}: ${entry.value}`);
        }
      }
      lines.push('');
    }

    lines.push('Planned with Wandrly');
    return lines.join('\n');
  }

  // ── Calendar (FR-EXP-05) ────────────────────────────────────────────

  /**
   * RFC 5545 calendar.
   *
   * Timed blocks become VEVENTs; untimed blocks become all-day events on their
   * day's date, which is why `FR-BLK-12`'s structured `startAt`/`endAt` had to
   * exist before this could work at all.
   */
  async toIcs(access: TripAccess, options: ExportOptions): Promise<string> {
    const model = await this.model(access, options);

    const stamp = (date: Date): string =>
      `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
    const dateOnly = (value: string): string => value.replace(/-/g, '');

    /** RFC 5545 §3.1: escape, then fold at 75 octets. */
    const line = (raw: string): string => {
      const escaped = raw
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\;')
        .replace(/,/g, '\\,')
        .replace(/\n/g, '\\n');
      if (escaped.length <= 75) return escaped;
      const parts = [escaped.slice(0, 75)];
      for (let i = 75; i < escaped.length; i += 74) parts.push(` ${escaped.slice(i, i + 74)}`);
      return parts.join('\r\n');
    };

    const out: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Wandrly//Trip Export//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      line(`X-WR-CALNAME:${model.title}`),
    ];

    const now = stamp(new Date());
    let sequence = 0;

    for (const day of model.days) {
      for (const block of day.blocks) {
        sequence += 1;
        const uid = `wandrly-${access.tripId}-${sequence}@wandrly.app`;

        out.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${now}`);

        if (block.startAt) {
          out.push(`DTSTART:${stamp(block.startAt)}`);
          out.push(`DTEND:${stamp(block.endAt ?? new Date(block.startAt.getTime() + 3_600_000))}`);
        } else if (day.date) {
          // All-day event: DTEND is exclusive, so it is the following day.
          const next = new Date(`${day.date}T00:00:00Z`);
          next.setUTCDate(next.getUTCDate() + 1);
          out.push(`DTSTART;VALUE=DATE:${dateOnly(day.date)}`);
          out.push(`DTEND;VALUE=DATE:${dateOnly(next.toISOString().slice(0, 10))}`);
        } else {
          // No date at all — an undated block cannot be a calendar entry.
          out.pop();
          out.pop();
          out.pop();
          continue;
        }

        out.push(line(`SUMMARY:${block.title || block.type}`));

        const description = [block.meta, block.notes, block.cost]
          .filter(Boolean)
          .join(' · ');
        if (description) out.push(line(`DESCRIPTION:${description}`));
        if (block.location) out.push(line(`LOCATION:${block.location}`));

        out.push(`STATUS:${block.isConfirmed ? 'CONFIRMED' : 'TENTATIVE'}`, 'END:VEVENT');
      }
    }

    out.push('END:VCALENDAR');
    return out.join('\r\n');
  }

  // ── PDF (FR-EXP-03) ─────────────────────────────────────────────────

  async toPdf(access: TripAccess, options: ExportOptions): Promise<Buffer> {
    const model = await this.model(access, options);

    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 56, bufferPages: true });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const ACCENT = '#C1703A';
      const MUTED = '#6B7280';

      // Cover
      doc.fontSize(30).fillColor('#111').text(model.title, { lineGap: 4 });
      doc.moveDown(0.3);
      doc.fontSize(12).fillColor(MUTED).text(`${model.destination} · ${model.dateRangeLabel}`);
      if (model.variantName !== 'Main') {
        doc.fontSize(10).fillColor(ACCENT).text(`Variant: ${model.variantName}`);
      }
      doc.moveDown(1.2);

      for (const day of model.days) {
        // Keep a day header with at least some of its content.
        if (doc.y > 700) doc.addPage();

        doc
          .fontSize(9)
          .fillColor(ACCENT)
          .text(
            `DAY ${String(day.dayNumber).padStart(2, '0')}${day.date ? `  ·  ${day.date}` : ''}`,
            { characterSpacing: 1 },
          );

        if (day.title) doc.fontSize(15).fillColor('#111').text(day.title);
        if (day.note) doc.fontSize(10).fillColor(MUTED).text(`"${day.note}"`, { oblique: true });
        doc.moveDown(0.4);

        if (day.blocks.length === 0) {
          doc.fontSize(10).fillColor(MUTED).text('  Nothing planned yet.');
        }

        for (const block of day.blocks) {
          if (doc.y > 760) doc.addPage();

          const heading = [block.timeLabel, block.title].filter(Boolean).join('   ');
          doc.fontSize(11).fillColor('#111').text(heading, { continued: block.isConfirmed });
          if (block.isConfirmed) doc.fillColor('#3F8F63').text('   ✓ booked');

          const detail = [block.meta, block.location ? `@ ${block.location}` : null, block.cost]
            .filter(Boolean)
            .join('  ·  ');
          if (detail) doc.fontSize(9.5).fillColor(MUTED).text(detail, { indent: 12 });
          if (block.notes) doc.fontSize(9.5).fillColor(MUTED).text(block.notes, { indent: 12 });

          for (const entry of block.booking ?? []) {
            doc.fontSize(9).fillColor(MUTED).text(`${entry.key}: ${entry.value}`, { indent: 12 });
          }

          doc.moveDown(0.35);
        }

        doc.moveDown(0.6);
      }

      // Footer on every page, added after layout so the count is known.
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i += 1) {
        doc.switchToPage(i);
        doc
          .fontSize(8)
          .fillColor(MUTED)
          .text(
            `${model.title}  ·  Planned with Wandrly  ·  ${i - range.start + 1}/${range.count}`,
            56,
            790,
            { align: 'center', width: doc.page.width - 112 },
          );
      }

      doc.end();
    });
  }

  // ── Expense report (FR-SPLIT-37) ────────────────────────────────────

  /** One row per share, so the file drops straight into a spreadsheet. */
  async expensesCsv(access: TripAccess): Promise<string> {
    const result = await db.execute<{
      spent_at: string;
      description: string;
      category: string;
      currency: string;
      amount_minor: string;
      base_amount_minor: string;
      payer: string;
      participant: string;
      share_minor: string;
      share_base_minor: string;
    }>(sql`
      select to_char(e.spent_at, 'YYYY-MM-DD') as spent_at,
             e.description, e.category, e.currency,
             e.amount_minor::text, e.amount_base_minor::text as base_amount_minor,
             (select string_agg(pp.display_name, ' + ')
                from expense_payments ep
                join trip_participants pp on pp.id = ep.participant_id
               where ep.expense_id = e.id) as payer,
             p.display_name as participant,
             es.share_amount_minor::text as share_minor,
             es.share_amount_base_minor::text as share_base_minor
        from expenses e
        join expense_shares es on es.expense_id = e.id
        join trip_participants p on p.id = es.participant_id
       where e.trip_id = ${access.tripId} and e.deleted_at is null
       order by e.spent_at, e.id, p.display_name
    `);

    const escape = (value: string): string =>
      /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

    const header = [
      'date', 'description', 'category', 'currency', 'amount', 'paid_by',
      'participant', 'share', `share_in_${access.baseCurrency.toLowerCase()}`,
    ];

    const rows = (result.rows ?? []).map((row) =>
      [
        row.spent_at,
        row.description,
        row.category,
        row.currency,
        formatMinor(BigInt(row.amount_minor), row.currency),
        row.payer ?? '',
        row.participant,
        formatMinor(BigInt(row.share_minor), row.currency),
        formatMinor(BigInt(row.share_base_minor), access.baseCurrency),
      ]
        .map((cell) => escape(String(cell)))
        .join(','),
    );

    return [header.join(','), ...rows].join('\n');
  }
}

export const exportsService = new ExportsService();
