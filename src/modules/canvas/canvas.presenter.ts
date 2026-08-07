/**
 * Canvas row → DTO mapping.
 *
 * Booking section values arrive here already decrypted by the service; this
 * layer only shapes them. Nothing else is permitted to emit block sections.
 */

import type { BlockRow, DayRow, VariantRow } from '../../platform/db/schema/index';
import type { BlockSections } from '../../contracts/canvas';
import type { DayWithBlocks, VariantWithCounts } from './canvas.repository';

export function toVariantDTO(variant: VariantWithCounts | VariantRow) {
  const counts = variant as VariantWithCounts;
  return {
    id: variant.id,
    tripId: variant.tripId,
    name: variant.name,
    isMain: variant.isMain,
    forkedFromId: variant.forkedFromId,
    dayCount: counts.dayCount ?? 0,
    blockCount: counts.blockCount ?? 0,
    createdAt: variant.createdAt.toISOString(),
  };
}

export function toDayDTO(day: DayRow) {
  return {
    id: day.id,
    variantId: day.variantId,
    dayNumber: day.dayNumber,
    date: day.date,
    title: day.title,
    note: day.note,
    status: day.status,
    weather: day.weatherCache ?? null,
    version: day.version,
  };
}

export function toBlockDTO(block: BlockRow) {
  return {
    id: block.id,
    dayId: block.dayId,
    type: block.type,
    title: block.title,
    timeLabel: block.timeLabel,
    startAt: block.startAt?.toISOString() ?? null,
    endAt: block.endAt?.toISOString() ?? null,
    meta: block.meta,
    notes: block.notes,
    isConfirmed: block.isConfirmed,
    sortOrder: block.sortOrder,
    sections: (block.sections ?? {}) as BlockSections,
    createdBy: block.createdBy,
    version: block.version,
    createdAt: block.createdAt.toISOString(),
    updatedAt: block.updatedAt.toISOString(),
  };
}

export function toCanvasDTO(canvas: {
  variant: VariantWithCounts;
  days: DayWithBlocks[];
}) {
  return {
    variant: toVariantDTO(canvas.variant),
    days: canvas.days.map((day) => ({
      ...toDayDTO(day),
      blocks: day.blocks.map(toBlockDTO),
    })),
  };
}
