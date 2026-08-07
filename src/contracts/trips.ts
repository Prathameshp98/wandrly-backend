/**
 * Trip and folder contracts. FR-TRIP-*, FR-FOLD-*, FR-DASH-*.
 */

import { z } from 'zod';

import {
  CurrencyCode,
  IsoDate,
  IsoDateTime,
  TripMode,
  TripStatus,
  Uuid,
} from './common';

export const CreateTripBody = z.object({
  /** Required — a trip always starts from a destination (FR-TRIP-02). */
  destination: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(80).optional(),
  startDate: IsoDate.optional(),
  endDate: IsoDate.optional(),
  folderId: Uuid.nullish(),
  placeId: z.string().max(200).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  baseCurrency: CurrencyCode.optional(),
  /** FR-SPLIT-02 — an expenses-only trip suppresses the canvas entirely. */
  tripMode: TripMode.default('FULL'),
});

/**
 * FR-TRIP-14 — changing dates on a trip that already has days must never
 * silently destroy them. The server refuses to guess.
 */
export const DateChangeStrategy = z.enum(['SHIFT', 'TRUNCATE', 'EXTEND', 'KEEP_DAYS']);

export const UpdateTripBody = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(80).optional(),
    subtitle: z.string().trim().max(120).optional(),
    destination: z.string().trim().max(120).optional(),
    startDate: IsoDate.nullish(),
    endDate: IsoDate.nullish(),
    status: TripStatus.optional(),
    folderId: Uuid.nullish(),
    baseCurrency: CurrencyCode.optional(),
    simplifyDebts: z.boolean().optional(),
    dateChangeStrategy: DateChangeStrategy.optional(),
  })
  .refine((value) => Object.keys(value).length > 1, {
    message: 'Provide at least one field to update',
  });

export const TripSummaryDTO = z.object({
  id: Uuid,
  title: z.string(),
  subtitle: z.string(),
  destination: z.string(),
  startDate: IsoDate.nullable(),
  endDate: IsoDate.nullable(),
  dateRangeLabel: z.string(),
  status: TripStatus,
  tripMode: TripMode,
  baseCurrency: CurrencyCode,
  folderId: Uuid.nullable(),
  coverHue: z.number().int(),
  coverHue2: z.number().int(),
  isArchived: z.boolean(),
  isPinned: z.boolean(),
  sortOrder: z.number().int(),
  role: z.enum(['OWNER', 'EDITOR', 'CONTRIBUTOR', 'VIEWER']),
  /** Derived, never stored — the prototype's counts drifted from reality. */
  dayCount: z.number().int(),
  blockCount: z.number().int(),
  variantCount: z.number().int(),
  memberCount: z.number().int(),
  /** FR-DASH-07 — a real, explainable number. */
  readinessPct: z.number().int().min(0).max(100),
  bookableBlockCount: z.number().int(),
  confirmedBlockCount: z.number().int(),
  /** FR-DASH-08 — null when the trip has no start date or is in the past. */
  daysToGo: z.number().int().nullable(),
  version: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ListTripsQuery = z.object({
  view: z.enum(['dashboard', 'shared', 'archive', 'folder']).default('dashboard'),
  folderId: Uuid.optional(),
  search: z.string().trim().max(120).optional(),
});

export const CreateFolderBody = z.object({
  name: z.string().trim().min(1).max(40),
  emoji: z.string().min(1).max(8).default('🗺'),
  tone: z.enum(['gold', 'teal', 'sienna', 'forest', 'sand']).default('gold'),
});

export const UpdateFolderBody = CreateFolderBody.partial().extend({
  isPinned: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const FolderDTO = z.object({
  id: Uuid,
  name: z.string(),
  emoji: z.string(),
  tone: z.string(),
  isPinned: z.boolean(),
  sortOrder: z.number().int(),
  tripCount: z.number().int(),
});

export const ReorderTripsBody = z.object({
  orderedTripIds: z.array(Uuid).min(1).max(500),
});

export const MoveTripBody = z.object({
  folderId: Uuid.nullable(),
});

/** FR-AUTH-07 — deletion must offer a choice for owned trips. */
export const DeleteAccountBody = z.object({
  ownedTrips: z.enum(['TRANSFER', 'DELETE']),
  transferToUserId: Uuid.optional(),
});

export type CreateTripBody = z.infer<typeof CreateTripBody>;
export type UpdateTripBody = z.infer<typeof UpdateTripBody>;
export type CreateFolderBody = z.infer<typeof CreateFolderBody>;
export type ListTripsQuery = z.infer<typeof ListTripsQuery>;
export type DateChangeStrategy = z.infer<typeof DateChangeStrategy>;
