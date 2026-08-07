/**
 * Trip → DTO mapping.
 *
 * All derived values are computed here or in SQL, never stored — the prototype
 * stored day/block counts on the trip and they drifted immediately (PRD §6.2).
 */

import type { FolderRow } from '../../platform/db/schema/index';
import type { TripListRow } from './trips.repository';
import { daysUntil, formatDateRange } from './date-utils';

/**
 * FR-DASH-07 — readiness is a real, explainable number.
 *
 * `confirmed / total` over bookable blocks in the main variant. The prototype
 * faked this with a status lookup plus a char-code wobble, which is precisely
 * the kind of number users act on and shouldn't.
 */
export function readinessOf(trip: TripListRow): number {
  if (trip.status === 'COMPLETED') return 100;
  if (trip.bookableBlockCount === 0) return 0;
  // eslint-disable-next-line no-restricted-syntax -- a percentage, not money
  return Math.round((trip.confirmedBlockCount / trip.bookableBlockCount) * 100);
}

export function toTripDTO(trip: TripListRow, timezone = 'Asia/Kolkata') {
  return {
    id: trip.id,
    title: trip.title,
    subtitle: trip.subtitle,
    destination: trip.destination,
    startDate: trip.startDate,
    endDate: trip.endDate,
    dateRangeLabel: formatDateRange(trip.startDate, trip.endDate),
    status: trip.status,
    tripMode: trip.tripMode,
    baseCurrency: trip.baseCurrency,
    simplifyDebts: trip.simplifyDebts,
    folderId: trip.folderId,
    coverHue: trip.coverHue,
    coverHue2: trip.coverHue2,
    isArchived: trip.isArchived,
    isPinned: trip.isPinned,
    sortOrder: trip.userSortOrder,
    role: trip.role,
    dayCount: trip.dayCount,
    blockCount: trip.blockCount,
    variantCount: trip.variantCount,
    memberCount: trip.memberCount,
    bookableBlockCount: trip.bookableBlockCount,
    confirmedBlockCount: trip.confirmedBlockCount,
    readinessPct: readinessOf(trip),
    daysToGo: daysUntil(trip.startDate, timezone),
    version: trip.version,
    createdAt: trip.createdAt.toISOString(),
    updatedAt: trip.updatedAt.toISOString(),
  };
}

export function toFolderDTO(folder: FolderRow & { tripCount: number }) {
  return {
    id: folder.id,
    name: folder.name,
    emoji: folder.emoji,
    tone: folder.tone,
    isPinned: folder.isPinned,
    sortOrder: folder.sortOrder,
    tripCount: folder.tripCount,
  };
}

/** FR-DASH-04 — aggregate stats for the dashboard header. */
export function toDashboardStats(trips: TripListRow[]) {
  const active = trips.filter((trip) => !trip.isArchived);
  const nextTrip = active
    .filter((trip) => daysUntil(trip.startDate, 'Asia/Kolkata') !== null)
    .sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''))[0];

  return {
    tripCount: active.length,
    daysPlanned: active.reduce((sum, trip) => sum + trip.dayCount, 0),
    crewCount: Math.max(...active.map((trip) => trip.memberCount), 0),
    nextTripId: nextTrip?.id ?? null,
  };
}
