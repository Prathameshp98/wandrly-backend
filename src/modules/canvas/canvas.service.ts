/**
 * Canvas orchestration — variants, days, blocks, sections.
 *
 * The centrepiece is `forkVariant`. Every variant owns its OWN day/block tree;
 * the prototype shared one tree across all variants, which made forking a no-op
 * and left the product's differentiator unimplemented. This is the first real
 * implementation, so it is the piece to read carefully.
 *
 * Two ordering rules the prototype got wrong and this does not:
 *   • Duplicating a day inserts it immediately AFTER the source, not at the end
 *     — an itinerary is chronological (FR-DAY-05).
 *   • Blocks can be reordered WITHIN a day, not only moved between days
 *     (FR-BLK-08).
 */

import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';

import { limits } from '../../platform/config/env';
import { newId, decryptRecord, encryptRecord } from '../../platform/crypto/index';
import { db, withTransaction, type Executor } from '../../platform/db/index';
import { blocks, days, trips, variants } from '../../platform/db/schema/index';
import {
  DomainRuleError,
  LimitExceededError,
  NotFoundError,
  StaleWriteError,
} from '../../platform/errors/AppError';
import { DeferredBroadcast } from '../../platform/realtime/hub';
import { assert, type TripAccess } from '../../platform/policy/index';
import type {
  BlockSections,
  CreateBlockBody,
  CreateDayBody,
  CreateVariantBody,
  MoveBlockBody,
  UpdateBlockBody,
  UpdateDayBody,
} from '../../contracts/canvas';
import { activityService, type ActivityService } from '../notifications/activity.service';
import { CanvasRepository } from './canvas.repository';

export interface CanvasServiceDeps {
  readonly canvas: CanvasRepository;
  readonly activity: ActivityService;
}

/** Gap between sortOrder values, so a single insert rarely needs a renumber. */
const SORT_STEP = 1000;

export class CanvasService {
  constructor(private readonly deps: CanvasServiceDeps) {}

  // ── Reads ─────────────────────────────────────────────────────────

  async getCanvas(access: TripAccess, variantId?: string) {
    // Resolve through listVariants either way, so the response always carries
    // the same day/block counts whether a variant was named or defaulted.
    const all = await this.deps.canvas.listVariants(db, access.tripId);
    const variant = variantId
      ? all.find((candidate) => candidate.id === variantId)
      : (all.find((candidate) => candidate.isMain) ?? all[0]);

    if (!variant) throw new NotFoundError('Variant');

    const dayRows = await this.deps.canvas.daysWithBlocks(db, variant.id);

    return {
      variant,
      days: dayRows.map((day) => ({
        ...day,
        blocks: day.blocks.map((block) => this.decryptBlock(block)),
      })),
    };
  }

  async listVariants(access: TripAccess) {
    return this.deps.canvas.listVariants(db, access.tripId);
  }

  // ── Variants ──────────────────────────────────────────────────────

  /**
   * Create a variant, optionally forking an existing one (FR-VAR-03).
   *
   * A fork DEEP-COPIES days, blocks, and sections. Nothing is shared with the
   * source: editing the fork must never touch the original, which is the entire
   * point of the feature.
   */
  async createVariant(access: TripAccess, input: CreateVariantBody) {
    const broadcast = new DeferredBroadcast();
    const variantId = newId();

    await withTransaction(async (tx) => {
      const count = await this.deps.canvas.countVariants(tx, access.tripId);
      if (count >= limits.variantsPerTrip) {
        throw new LimitExceededError('variants on a trip', limits.variantsPerTrip);
      }

      if (input.forkFromVariantId) {
        await this.requireVariant(tx, access.tripId, input.forkFromVariantId);
      }

      await tx.insert(variants).values({
        id: variantId,
        tripId: access.tripId,
        name: input.name,
        isMain: false,
        forkedFromId: input.forkFromVariantId ?? null,
        createdBy: access.userId,
      });

      if (input.forkFromVariantId) {
        await this.deepCopyTree(tx, input.forkFromVariantId, variantId, access.userId);
      }

      await this.deps.activity.record(tx, {
        tripId: access.tripId,
        actorId: access.userId,
        kind: 'variant.created',
        entityType: 'variant',
        entityId: variantId,
        after: { name: input.name, forkedFrom: input.forkFromVariantId ?? null },
      });

      broadcast.queue({
        kind: 'variant.created',
        tripId: access.tripId,
        entityId: variantId,
        actorId: access.userId,
      });
    });

    broadcast.flush();

    // Re-read through listVariants so the response carries day/block counts —
    // a fork's whole point is that it copied something, and the client should
    // see how much without a second round trip.
    const all = await this.deps.canvas.listVariants(db, access.tripId);
    return all.find((variant) => variant.id === variantId)!;
  }

  /**
   * Deep-copy one variant's entire tree into another.
   *
   * Bulk-inserts rather than looping per block: a 90-day trip with 200 blocks a
   * day would otherwise issue thousands of statements inside one transaction.
   */
  private async deepCopyTree(
    tx: Executor,
    sourceVariantId: string,
    targetVariantId: string,
    actorId: string,
  ): Promise<void> {
    const sourceDays = await tx
      .select()
      .from(days)
      .where(eq(days.variantId, sourceVariantId))
      .orderBy(asc(days.dayNumber));

    if (sourceDays.length === 0) return;

    const dayIdMap = new Map<string, string>();
    const newDays = sourceDays.map((day) => {
      const targetId = newId();
      dayIdMap.set(day.id, targetId);
      return {
        id: targetId,
        variantId: targetVariantId,
        dayNumber: day.dayNumber,
        date: day.date,
        title: day.title,
        note: day.note,
        status: day.status,
        weatherCache: day.weatherCache,
      };
    });

    await tx.insert(days).values(newDays);

    const sourceBlocks = await tx
      .select()
      .from(blocks)
      .where(
        and(
          sql`${blocks.dayId} in (${sql.join(
            sourceDays.map((day) => sql`${day.id}::uuid`),
            sql`, `,
          )})`,
          isNull(blocks.deletedAt),
        ),
      )
      .orderBy(asc(blocks.sortOrder));

    if (sourceBlocks.length === 0) return;

    await tx.insert(blocks).values(
      sourceBlocks.map((block) => ({
        id: newId(),
        dayId: dayIdMap.get(block.dayId)!,
        type: block.type,
        title: block.title,
        timeLabel: block.timeLabel,
        startAt: block.startAt,
        endAt: block.endAt,
        meta: block.meta,
        notes: block.notes,
        isConfirmed: block.isConfirmed,
        sortOrder: block.sortOrder,
        // Sections are copied verbatim, including already-encrypted booking
        // values — no decrypt/re-encrypt round trip needed.
        sections: block.sections,
        createdBy: actorId,
      })),
    );
  }

  async renameVariant(access: TripAccess, variantId: string, name: string) {
    await this.requireVariant(db, access.tripId, variantId);
    const [updated] = await db
      .update(variants)
      .set({ name })
      .where(eq(variants.id, variantId))
      .returning();
    return updated!;
  }

  /** FR-VAR-06 — the previous main is retained as a normal variant, never deleted. */
  async promoteVariant(access: TripAccess, variantId: string) {
    const broadcast = new DeferredBroadcast();

    await withTransaction(async (tx) => {
      await this.requireVariant(tx, access.tripId, variantId);

      // Clear first: `one_main_per_trip` is a partial unique index, so two rows
      // must never be main simultaneously, even transiently.
      await tx
        .update(variants)
        .set({ isMain: false })
        .where(and(eq(variants.tripId, access.tripId), eq(variants.isMain, true)));

      await tx.update(variants).set({ isMain: true }).where(eq(variants.id, variantId));
      await tx
        .update(trips)
        .set({ mainVariantId: variantId })
        .where(eq(trips.id, access.tripId));

      await this.deps.activity.record(tx, {
        tripId: access.tripId,
        actorId: access.userId,
        kind: 'variant.promoted',
        entityType: 'variant',
        entityId: variantId,
      });

      broadcast.queue({
        kind: 'variant.promoted',
        tripId: access.tripId,
        entityId: variantId,
        actorId: access.userId,
      });
    });

    broadcast.flush();
  }

  /** FR-VAR-07 — the main variant cannot be deleted without promoting another. */
  async deleteVariant(access: TripAccess, variantId: string): Promise<void> {
    await withTransaction(async (tx) => {
      const variant = await this.requireVariant(tx, access.tripId, variantId);

      if (variant.isMain) {
        throw new DomainRuleError(
          'This is the main variant. Promote another one before deleting it.',
        );
      }

      await tx.delete(variants).where(eq(variants.id, variantId));

      await this.deps.activity.record(tx, {
        tripId: access.tripId,
        actorId: access.userId,
        kind: 'variant.deleted',
        entityType: 'variant',
        entityId: variantId,
        before: { name: variant.name },
      });
    });
  }

  // ── Days ──────────────────────────────────────────────────────────

  async addDay(access: TripAccess, variantId: string, input: CreateDayBody) {
    const broadcast = new DeferredBroadcast();
    const dayId = newId();

    await withTransaction(async (tx) => {
      await this.requireVariant(tx, access.tripId, variantId);

      const count = await this.deps.canvas.countDays(tx, variantId);
      if (count >= limits.daysPerVariant) {
        throw new LimitExceededError('days on a trip', limits.daysPerVariant);
      }

      await tx.insert(days).values({
        id: dayId,
        variantId,
        dayNumber: count + 1,
        date: input.date ?? null,
        title: input.title,
        note: input.note,
      });

      broadcast.queue({
        kind: 'day.created',
        tripId: access.tripId,
        entityId: dayId,
        actorId: access.userId,
      });
    });

    broadcast.flush();
    return (await this.deps.canvas.findDay(db, dayId))!;
  }

  async updateDay(access: TripAccess, dayId: string, input: UpdateDayBody) {
    const day = await this.requireDay(db, access.tripId, dayId);

    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.note !== undefined) patch.note = input.note;
    if (input.date !== undefined) patch.date = input.date;
    if (input.status !== undefined) patch.status = input.status;

    const [updated] = await db
      .update(days)
      .set({ ...patch, version: sql`${days.version} + 1` })
      .where(and(eq(days.id, day.id), eq(days.version, input.version)))
      .returning();

    if (!updated) throw new StaleWriteError(await this.deps.canvas.findDay(db, dayId));
    return updated;
  }

  /**
   * FR-DAY-04 — deleting renumbers the remaining days contiguously.
   *
   * The `days_variant_number_uq` constraint is DEFERRABLE precisely so the
   * renumber can happen in one UPDATE without transiently colliding.
   */
  async deleteDay(access: TripAccess, dayId: string): Promise<void> {
    const broadcast = new DeferredBroadcast();

    await withTransaction(async (tx) => {
      const day = await this.requireDay(tx, access.tripId, dayId);

      await tx.delete(days).where(eq(days.id, dayId));

      await tx
        .update(days)
        .set({ dayNumber: sql`${days.dayNumber} - 1` })
        .where(and(eq(days.variantId, day.variantId), gt(days.dayNumber, day.dayNumber)));

      await this.deps.activity.record(tx, {
        tripId: access.tripId,
        actorId: access.userId,
        kind: 'day.deleted',
        entityType: 'day',
        entityId: dayId,
        before: { dayNumber: day.dayNumber, title: day.title },
      });

      broadcast.queue({
        kind: 'day.deleted',
        tripId: access.tripId,
        entityId: dayId,
        actorId: access.userId,
      });
    });

    broadcast.flush();
  }

  /**
   * FR-DAY-05 — the copy is inserted immediately AFTER the source.
   *
   * The prototype appended it to the end of the trip, which is wrong for a
   * chronological itinerary: duplicating day 2 of 7 should produce a new day 3.
   */
  async duplicateDay(access: TripAccess, dayId: string) {
    const newDayId = newId();

    await withTransaction(async (tx) => {
      const day = await this.requireDay(tx, access.tripId, dayId);

      const count = await this.deps.canvas.countDays(tx, day.variantId);
      if (count >= limits.daysPerVariant) {
        throw new LimitExceededError('days on a trip', limits.daysPerVariant);
      }

      // Make room at dayNumber + 1.
      await tx
        .update(days)
        .set({ dayNumber: sql`${days.dayNumber} + 1` })
        .where(and(eq(days.variantId, day.variantId), gt(days.dayNumber, day.dayNumber)));

      await tx.insert(days).values({
        id: newDayId,
        variantId: day.variantId,
        dayNumber: day.dayNumber + 1,
        // The copy is undated: it is an extra day, not the same calendar date.
        date: null,
        title: day.title ? `${day.title} · copy` : '',
        note: day.note,
        status: day.status,
      });

      const sourceBlocks = await tx
        .select()
        .from(blocks)
        .where(and(eq(blocks.dayId, dayId), isNull(blocks.deletedAt)))
        .orderBy(asc(blocks.sortOrder));

      if (sourceBlocks.length > 0) {
        await tx.insert(blocks).values(
          sourceBlocks.map((block) => ({
            id: newId(),
            dayId: newDayId,
            type: block.type,
            title: block.title,
            timeLabel: block.timeLabel,
            startAt: block.startAt,
            endAt: block.endAt,
            meta: block.meta,
            notes: block.notes,
            isConfirmed: block.isConfirmed,
            sortOrder: block.sortOrder,
            sections: block.sections,
            createdBy: access.userId,
          })),
        );
      }
    });

    return (await this.deps.canvas.findDay(db, newDayId))!;
  }

  /** FR-DAY-06 — reorder days; numbers and the deferred constraint do the rest. */
  async reorderDays(access: TripAccess, variantId: string, orderedDayIds: string[]) {
    await withTransaction(async (tx) => {
      await this.requireVariant(tx, access.tripId, variantId);

      const existing = await tx
        .select({ id: days.id })
        .from(days)
        .where(eq(days.variantId, variantId));

      const known = new Set(existing.map((row) => row.id));
      if (orderedDayIds.length !== known.size || orderedDayIds.some((id) => !known.has(id))) {
        throw new DomainRuleError(
          'The reorder must list every day in this variant exactly once',
        );
      }

      for (const [index, id] of orderedDayIds.entries()) {
        await tx.update(days).set({ dayNumber: index + 1 }).where(eq(days.id, id));
      }
    });
  }

  // ── Blocks ────────────────────────────────────────────────────────

  async addBlock(access: TripAccess, dayId: string, input: CreateBlockBody) {
    const broadcast = new DeferredBroadcast();
    const blockId = newId();

    await withTransaction(async (tx) => {
      await this.requireDay(tx, access.tripId, dayId);

      const count = await this.deps.canvas.countBlocks(tx, dayId);
      if (count >= limits.blocksPerDay) {
        throw new LimitExceededError('blocks in a day', limits.blocksPerDay);
      }

      const maxSort = await this.deps.canvas.maxSortOrder(tx, dayId);

      await tx.insert(blocks).values({
        id: blockId,
        dayId,
        type: input.type,
        title: input.title,
        timeLabel: input.timeLabel,
        startAt: input.startAt ? new Date(input.startAt) : null,
        endAt: input.endAt ? new Date(input.endAt) : null,
        meta: input.meta,
        notes: input.notes ?? null,
        isConfirmed: input.isConfirmed,
        sortOrder: maxSort + SORT_STEP,
        sections: this.encryptSections(input.sections) as never,
        createdBy: access.userId,
      });

      broadcast.queue({
        kind: 'block.created',
        tripId: access.tripId,
        entityId: blockId,
        actorId: access.userId,
      });
    });

    broadcast.flush();
    const created = await this.deps.canvas.findBlock(db, blockId);
    return this.decryptBlock(created!);
  }

  async updateBlock(access: TripAccess, blockId: string, input: UpdateBlockBody) {
    const broadcast = new DeferredBroadcast();

    const block = await this.requireBlock(db, access.tripId, blockId);

    // Contributors may only edit their own blocks — the policy engine resolves
    // `block:edit-any` down to `block:edit-own` using this.
    assert(access, 'block:edit-any', { createdBy: block.createdBy });

    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.timeLabel !== undefined) patch.timeLabel = input.timeLabel;
    if (input.startAt !== undefined) patch.startAt = input.startAt ? new Date(input.startAt) : null;
    if (input.endAt !== undefined) patch.endAt = input.endAt ? new Date(input.endAt) : null;
    if (input.meta !== undefined) patch.meta = input.meta;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.isConfirmed !== undefined) patch.isConfirmed = input.isConfirmed;
    if (input.sections !== undefined) patch.sections = this.encryptSections(input.sections);

    const [updated] = await db
      .update(blocks)
      .set({ ...patch, version: sql`${blocks.version} + 1`, updatedAt: new Date() })
      .where(and(eq(blocks.id, blockId), eq(blocks.version, input.version)))
      .returning();

    if (!updated) {
      throw new StaleWriteError(this.decryptBlock(block));
    }

    broadcast.queue({
      kind: 'block.updated',
      tripId: access.tripId,
      entityId: blockId,
      version: updated.version,
      actorId: access.userId,
    });
    broadcast.flush();

    return this.decryptBlock(updated);
  }

  async deleteBlock(access: TripAccess, blockId: string): Promise<void> {
    const block = await this.requireBlock(db, access.tripId, blockId);

    assert(access, 'block:edit-any', { createdBy: block.createdBy });

    await db.update(blocks).set({ deletedAt: new Date() }).where(eq(blocks.id, blockId));

    const broadcast = new DeferredBroadcast();
    broadcast.queue({
      kind: 'block.deleted',
      tripId: access.tripId,
      entityId: blockId,
      actorId: access.userId,
    });
    broadcast.flush();
  }

  async restoreBlock(access: TripAccess, blockId: string): Promise<void> {
    // Scope to the trip in the URL. Looking the block up by bare id — and then
    // discarding `access` entirely — let anyone who could edit *any* trip
    // resurrect a soft-deleted block from *any other* trip.
    const block = await this.deps.canvas.findBlockInTrip(db, access.tripId, blockId, {
      includeDeleted: true,
    });
    if (!block) throw new NotFoundError('Block');

    assert(access, 'block:edit-any', { createdBy: block.createdBy });

    await db.update(blocks).set({ deletedAt: null }).where(eq(blocks.id, blockId));

    const broadcast = new DeferredBroadcast();
    broadcast.queue({
      kind: 'block.restored',
      tripId: access.tripId,
      entityId: blockId,
      actorId: access.userId,
    });
    broadcast.flush();
  }

  /**
   * FR-BLK-07 + FR-BLK-08 — move a block between days AND position it.
   *
   * One endpoint for both because they are the same operation from the client's
   * point of view: a drag ends at a (day, index) pair.
   */
  async moveBlock(access: TripAccess, blockId: string, input: MoveBlockBody) {
    const broadcast = new DeferredBroadcast();

    await withTransaction(async (tx) => {
      const block = await this.requireBlock(tx, access.tripId, blockId);
      const targetDay = await this.requireDay(tx, access.tripId, input.toDayId);

      // Both days must belong to the same variant: a block cannot jump between
      // parallel plans.
      const sourceDay = await this.deps.canvas.findDay(tx, block.dayId);
      if (sourceDay && sourceDay.variantId !== targetDay.variantId) {
        throw new DomainRuleError('A block cannot move between variants');
      }

      const siblings = await tx
        .select({ id: blocks.id })
        .from(blocks)
        .where(and(eq(blocks.dayId, input.toDayId), isNull(blocks.deletedAt)))
        .orderBy(asc(blocks.sortOrder));

      const others = siblings.filter((row) => row.id !== blockId).map((row) => row.id);
      const index = Math.min(input.toIndex ?? others.length, others.length);
      const ordered = [...others.slice(0, index), blockId, ...others.slice(index)];

      await tx.update(blocks).set({ dayId: input.toDayId }).where(eq(blocks.id, blockId));

      for (const [position, id] of ordered.entries()) {
        await tx
          .update(blocks)
          .set({ sortOrder: (position + 1) * SORT_STEP })
          .where(eq(blocks.id, id));
      }

      await this.deps.activity.record(tx, {
        tripId: access.tripId,
        actorId: access.userId,
        kind: 'block.moved',
        entityType: 'block',
        entityId: blockId,
        before: { dayId: block.dayId },
        after: { dayId: input.toDayId, index },
      });

      broadcast.queue({
        kind: 'block.moved',
        tripId: access.tripId,
        entityId: blockId,
        actorId: access.userId,
      });
    });

    broadcast.flush();
  }

  async reorderBlocks(access: TripAccess, dayId: string, orderedBlockIds: string[]) {
    await withTransaction(async (tx) => {
      await this.requireDay(tx, access.tripId, dayId);

      const existing = await tx
        .select({ id: blocks.id })
        .from(blocks)
        .where(and(eq(blocks.dayId, dayId), isNull(blocks.deletedAt)));

      const known = new Set(existing.map((row) => row.id));
      if (orderedBlockIds.length !== known.size || orderedBlockIds.some((id) => !known.has(id))) {
        throw new DomainRuleError('The reorder must list every block in this day exactly once');
      }

      for (const [index, id] of orderedBlockIds.entries()) {
        await tx
          .update(blocks)
          .set({ sortOrder: (index + 1) * SORT_STEP })
          .where(eq(blocks.id, id));
      }
    });
  }

  // ── Section encryption (FR-NFR-SEC-02) ────────────────────────────

  /**
   * Booking details are confirmation numbers, PNRs, and seat assignments —
   * sensitive personal data. Encrypted at the application layer before they
   * reach the database, and never logged (see the pino redaction list).
   */
  private encryptSections(sections: BlockSections): BlockSections {
    if (!sections.booking) return sections;

    return {
      ...sections,
      booking: sections.booking.map(({ key, value }) => ({
        key,
        value: encryptRecord({ v: value }).v!,
      })),
    };
  }

  private decryptBlock<T extends { sections: unknown }>(block: T): T {
    const sections = (block.sections ?? {}) as BlockSections;
    if (!sections.booking) return block;

    return {
      ...block,
      sections: {
        ...sections,
        booking: sections.booking.map(({ key, value }) => ({
          key,
          value: decryptRecord({ v: value }).v!,
        })),
      },
    };
  }

  // ── Guards ────────────────────────────────────────────────────────
  // Each verifies the resource belongs to the caller's trip. Without this a
  // valid token for trip A could edit a block in trip B by id.

  private async requireVariant(exec: Executor, tripId: string, variantId: string) {
    const variant = await this.deps.canvas.findVariant(exec, variantId);
    if (!variant || variant.tripId !== tripId) throw new NotFoundError('Variant');
    return variant;
  }

  private async requireDay(exec: Executor, tripId: string, dayId: string) {
    const day = await this.deps.canvas.findDayInTrip(exec, tripId, dayId);
    if (!day) throw new NotFoundError('Day');
    return day;
  }

  private async requireBlock(exec: Executor, tripId: string, blockId: string) {
    const block = await this.deps.canvas.findBlockInTrip(exec, tripId, blockId);
    if (!block) throw new NotFoundError('Block');
    return block;
  }
}

export const canvasService = new CanvasService({
  canvas: new CanvasRepository(),
  activity: activityService,
});
