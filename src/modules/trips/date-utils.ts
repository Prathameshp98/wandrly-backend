/**
 * Calendar-date helpers.
 *
 * A "day" in an itinerary is a calendar concept, not an instant — see the
 * timestamp/date distinction in TECHNICAL_DESIGN §5.1. These operate on
 * `YYYY-MM-DD` strings and UTC-noon Dates so a timezone shift can never move a
 * day across a boundary.
 */

/** Parse `YYYY-MM-DD` to a Date anchored at UTC noon. */
export function parseISO(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year!, (month ?? 1) - 1, day ?? 1, 12, 0, 0));
}

/** Format a Date back to `YYYY-MM-DD`. */
export function formatISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, amount: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + amount);
  return result;
}

/** Whole calendar days between two dates. Same day → 0. */
export function differenceInCalendarDays(later: Date, earlier: Date): number {
  const MS_PER_DAY = 86_400_000;
  // eslint-disable-next-line no-restricted-syntax -- calendar days, not money
  return Math.round((later.getTime() - earlier.getTime()) / MS_PER_DAY);
}

/**
 * Days until a trip starts, in the user's timezone (FR-DASH-08).
 * Null when there is no start date or the trip is already over.
 */
export function daysUntil(startDate: string | null, timezone: string): number | null {
  if (!startDate) return null;

  const today = new Date(
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date()),
  );
  const diff = differenceInCalendarDays(parseISO(startDate), parseISO(formatISO(today)));

  return diff < 0 ? null : diff;
}

/** Human date range for cards, e.g. "May 18 – 24". */
export function formatDateRange(startDate: string | null, endDate: string | null): string {
  if (!startDate) return 'Dates TBD';

  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: '2-digit', timeZone: 'UTC' };
  const start = parseISO(startDate).toLocaleDateString('en-GB', opts);
  if (!endDate) return start;

  const end = parseISO(endDate);
  const sameMonth = startDate.slice(0, 7) === endDate.slice(0, 7);

  return sameMonth
    ? `${start} – ${end.toLocaleDateString('en-GB', { day: '2-digit', timeZone: 'UTC' })}`
    : `${start} – ${end.toLocaleDateString('en-GB', opts)}`;
}
