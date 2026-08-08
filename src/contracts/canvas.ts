/**
 * Canvas contracts — variants, days, blocks, and the six rich sections.
 * FR-VAR-*, FR-DAY-*, FR-BLK-*, FR-SEC-*.
 */

import { z } from 'zod';

import { limits } from '../platform/config/env';

import { BlockType, IsoDate, IsoDateTime, MoneyString, TripStatus, Uuid } from './common';

// ── Block sections (FR-SEC-01…09) ───────────────────────────────────

export const NotesSection = z.string().max(5000);

export const MapSection = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  name: z.string().min(1).max(200),
  placeId: z.string().max(200).optional(),
});

/**
 * A link the user pasted, rendered as an `<a href>` on the PUBLIC page.
 *
 * `.url()` alone is not enough: it defers to `new URL()`, which considers
 * `javascript:alert(1)`, `data:text/html,…` and `vbscript:` perfectly
 * well-formed. Escaping does not help — those payloads contain no markup — so a
 * Contributor could store one and it would ship to every unauthenticated
 * visitor of the share link as a clickable script.
 *
 * FR-SEC-05 imagines the SERVER fetching this metadata and sandboxing the
 * fetch. No such fetch exists; every field here is client-supplied, which
 * removes the SSRF surface and makes the scheme check the whole defence.
 */
const HttpUrl = z
  .string()
  .url()
  .max(2000)
  .refine(
    (value) => {
      try {
        return ['http:', 'https:'].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: 'Only http and https links are allowed' },
  );

export const LinkSection = z.object({
  url: HttpUrl,
  host: z.string().max(200),
  title: z.string().max(300),
  desc: z.string().max(1000).default(''),
  thumbAssetId: Uuid.optional(),
});

/** Ordered key/value pairs, so the display order the user chose is preserved. */
export const BookingSection = z
  .array(z.object({ key: z.string().min(1).max(60), value: z.string().max(500) }))
  .max(20);

export const CostSection = z.object({
  amountMinor: MoneyString,
  currency: z.string().length(3),
  per: z.enum(['pp', 'total']),
  splitCount: z.number().int().positive().max(50),
});

/**
 * `.strict()` so an unknown section key is rejected rather than silently stored
 * in JSONB, where it would never be validated again.
 */
export const BlockSections = z
  .object({
    notes: NotesSection.optional(),
    // FR-SEC-03's cap, read from config rather than written as a literal:
    // PRD D-10 makes every such ceiling configuration, and a hardcoded 20 left
    // LIMIT_PHOTOS_PER_BLOCK decorative — changing it moved nothing.
    photos: z.array(Uuid).max(limits.photosPerBlock).optional(),
    map: MapSection.optional(),
    link: LinkSection.optional(),
    booking: BookingSection.optional(),
    cost: CostSection.optional(),
  })
  .strict();

export type BlockSections = z.infer<typeof BlockSections>;

// ── Variants (FR-VAR-01…09) ─────────────────────────────────────────

export const CreateVariantBody = z.object({
  name: z.string().trim().min(1).max(40),
  /** Null / omitted ⇒ start fresh with empty days. Otherwise deep-copy. */
  forkFromVariantId: Uuid.nullish(),
});

export const UpdateVariantBody = z.object({
  name: z.string().trim().min(1).max(40),
});

export const VariantDTO = z.object({
  id: Uuid,
  tripId: Uuid,
  name: z.string(),
  isMain: z.boolean(),
  forkedFromId: Uuid.nullable(),
  dayCount: z.number().int(),
  blockCount: z.number().int(),
  createdAt: IsoDateTime,
});

// ── Days (FR-DAY-01…08) ─────────────────────────────────────────────

export const CreateDayBody = z.object({
  title: z.string().trim().max(60).default(''),
  note: z.string().trim().max(200).default(''),
  date: IsoDate.nullish(),
});

export const UpdateDayBody = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().max(60).optional(),
    note: z.string().trim().max(200).optional(),
    date: IsoDate.nullish(),
    status: TripStatus.optional(),
  })
  .refine((value) => Object.keys(value).length > 1, {
    message: 'Provide at least one field to update',
  });

export const ReorderDaysBody = z.object({
  orderedDayIds: z.array(Uuid).min(1).max(90),
});

export const DayDTO = z.object({
  id: Uuid,
  variantId: Uuid,
  dayNumber: z.number().int(),
  date: IsoDate.nullable(),
  title: z.string(),
  note: z.string(),
  status: TripStatus,
  weather: z.unknown().nullable(),
  version: z.number().int(),
});

// ── Blocks (FR-BLK-01…14) ───────────────────────────────────────────

export const CreateBlockBody = z.object({
  type: BlockType,
  title: z.string().trim().max(120).default(''),
  timeLabel: z.string().trim().max(40).default(''),
  startAt: IsoDateTime.nullish(),
  endAt: IsoDateTime.nullish(),
  meta: z.string().trim().max(120).default(''),
  notes: z.string().max(5000).nullish(),
  isConfirmed: z.boolean().default(false),
  sections: BlockSections.default({}),
});

export const UpdateBlockBody = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().max(120).optional(),
    timeLabel: z.string().trim().max(40).optional(),
    startAt: IsoDateTime.nullish(),
    endAt: IsoDateTime.nullish(),
    meta: z.string().trim().max(120).optional(),
    notes: z.string().max(5000).nullish(),
    isConfirmed: z.boolean().optional(),
    sections: BlockSections.optional(),
  })
  .refine((value) => Object.keys(value).length > 1, {
    message: 'Provide at least one field to update',
  });

/** FR-BLK-07 and FR-BLK-08 — one endpoint for both move and reorder. */
export const MoveBlockBody = z.object({
  toDayId: Uuid,
  /** Insert position within the target day. Omitted ⇒ append. */
  toIndex: z.number().int().min(0).max(200).optional(),
});

export const ReorderBlocksBody = z.object({
  orderedBlockIds: z.array(Uuid).min(1).max(200),
});

export const BlockDTO = z.object({
  id: Uuid,
  dayId: Uuid,
  type: BlockType,
  title: z.string(),
  timeLabel: z.string(),
  startAt: IsoDateTime.nullable(),
  endAt: IsoDateTime.nullable(),
  meta: z.string(),
  notes: z.string().nullable(),
  isConfirmed: z.boolean(),
  sortOrder: z.number().int(),
  sections: BlockSections,
  createdBy: Uuid.nullable(),
  version: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

/** The whole canvas for one variant — the canvas view's single fetch. */
export const CanvasDTO = z.object({
  variant: VariantDTO,
  days: z.array(DayDTO.extend({ blocks: z.array(BlockDTO) })),
});

export const CanvasQuery = z.object({
  variantId: Uuid.optional(),
});

export type CreateVariantBody = z.infer<typeof CreateVariantBody>;
export type CreateDayBody = z.infer<typeof CreateDayBody>;
export type UpdateDayBody = z.infer<typeof UpdateDayBody>;
export type CreateBlockBody = z.infer<typeof CreateBlockBody>;
export type UpdateBlockBody = z.infer<typeof UpdateBlockBody>;
export type MoveBlockBody = z.infer<typeof MoveBlockBody>;
