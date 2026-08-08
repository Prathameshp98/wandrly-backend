/**
 * Export routes.
 *
 * Synchronous for now: at ≤30 users a PDF renders in well under a second with
 * pdfkit. TECHNICAL_DESIGN §10 keeps the job queue for when that stops being
 * true (FR-EXP-06).
 */

import { Router } from 'express';

import { ExportQuery, TripIdParam } from '../../contracts/index';
import { validate, validated } from '../../platform/http/validate';
import { accessOf, withTripRead } from '../../platform/http/withTripAccess';
import { exportsService } from './exports.service';

export const exportsRouter = Router();

/** Safe filename stem from a user-supplied trip title. */
const slugify = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'trip';

const optionsFrom = (query: {
  variantId?: string;
  includeCosts: string;
  includeBookings: string;
  includeNotes: string;
}) => ({
  variantId: query.variantId,
  includeCosts: query.includeCosts === 'true',
  includeBookings: query.includeBookings === 'true',
  includeNotes: query.includeNotes === 'true',
});

exportsRouter.get(
  '/trips/:tripId/export.txt',
  validate({ params: TripIdParam, query: ExportQuery }),
  withTripRead('export:run'),
  async (req, res) => {
    const access = accessOf(req);
    const text = await exportsService.toText(access, optionsFrom(validated.query(req, ExportQuery)));
    res.type('text/plain; charset=utf-8').send(text);
  },
);

exportsRouter.get(
  '/trips/:tripId/export.ics',
  validate({ params: TripIdParam, query: ExportQuery }),
  withTripRead('export:run'),
  async (req, res) => {
    const access = accessOf(req);
    const ics = await exportsService.toIcs(access, optionsFrom(validated.query(req, ExportQuery)));
    res
      .type('text/calendar; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="wandrly-trip.ics"`)
      .send(ics);
  },
);

exportsRouter.get(
  '/trips/:tripId/export.pdf',
  validate({ params: TripIdParam, query: ExportQuery }),
  withTripRead('export:run'),
  async (req, res) => {
    const access = accessOf(req);
    const pdf = await exportsService.toPdf(access, optionsFrom(validated.query(req, ExportQuery)));
    res
      .type('application/pdf')
      .set('Content-Disposition', `attachment; filename="${slugify(access.tripId)}.pdf"`)
      .send(pdf);
  },
);

exportsRouter.get(
  '/trips/:tripId/expenses/export.csv',
  validate({ params: TripIdParam }),
  // PRD §8 has two distinct rows: "Export" admits every role, but "Export the
  // expense report" denies a Viewer. Gating this on 'export:run' handed a
  // Viewer the whole group ledger as CSV — the query is trip-scoped, not
  // participant-scoped — flatly contradicting "View the expense ledger:
  // Viewer = own shares only".
  withTripRead('expense:view'),
  async (req, res) => {
    const csv = await exportsService.expensesCsv(accessOf(req));
    res
      .type('text/csv; charset=utf-8')
      .set('Content-Disposition', 'attachment; filename="wandrly-expenses.csv"')
      .send(csv);
  },
);
