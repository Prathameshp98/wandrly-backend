/**
 * Trip and folder orchestration.
 *
 * Two behaviours worth reading before changing anything here:
 *
 *   • Trip creation builds the whole minimum graph in ONE transaction — trip,
 *     main variant, owner membership, owner ledger participant, and one day per
 *     date. The circular FK between trips and variants is DEFERRABLE precisely
 *     so this can happen in any order.
 *
 *   • Changing dates on a trip that already has days NEVER silently destroys
 *     them (FR-TRIP-14). The caller must state a strategy, or the request is
 *     rejected with the day counts so the client can ask.
 */

import { addDays, differenceInCalendarDays, formatISO, parseISO } from './date-utils';
import { eq, sql } from 'drizzle-orm';

import { limits } from '../../platform/config/env';
import { newId } from '../../platform/crypto/index';
import { withTransaction, db, type Executor } from '../../platform/db/index';
import {
  blocks,
  days,
  tripMembers,
  tripParticipants,
  trips,
  variants,
} from '../../platform/db/schema/index';
import {
  DateChangeStrategyRequiredError,
  DomainRuleError,
  LimitExceededError,
  NotFoundError,
} from '../../platform/errors/AppError';
import { DeferredBroadcast } from '../../platform/realtime/hub';
import type { TripAccess } from '../../platform/policy/index';
import type {
  CreateFolderBody,
  CreateTripBody,
  DateChangeStrategy,
  UpdateTripBody,
} from '../../contracts/trips';
import { activityService, type ActivityService } from '../notifications/activity.service';
import {
  FolderRepository,
  TripRepository,
  type TripListRow,
  type TripView,
} from './trips.repository';

export interface TripsServiceDeps {
  readonly trips: TripRepository;
  readonly folders: FolderRepository;
  readonly activity: ActivityService;
}

export class TripsService {
  constructor(private readonly deps: TripsServiceDeps) {}

  // ── Reads ─────────────────────────────────────────────────────────

  async list(
    userId: string,
    options: { view: TripView; folderId?: string; search?: string },
  ): Promise<TripListRow[]> {
    return this.deps.trips.listForUser(db, userId, options);
  }

  async get(userId: string, tripId: string): Promise<TripListRow> {
    const trip = await this.deps.trips.findForUser(db, userId, tripId);
    if (!trip) throw new NotFoundError('Trip');
    return trip;
  }

  // ── Create ────────────────────────────────────────────────────────

  async create(userId: string, input: CreateTripBody): Promise<TripListRow> {
    const tripId = newId();
    const variantId = newId();

    await withTransaction(async (tx) => {
      if (input.folderId) {
        const owned = await this.deps.folders.belongsTo(tx, input.folderId, userId);
        if (!owned) throw new NotFoundError('Folder');
      }

      await this.deps.trips.create(tx, {
        id: tripId,
        ownerId: userId,
        folderId: input.folderId ?? null,
        title: input.title ?? input.destination,
        destination: input.destination,
        placeId: input.placeId ?? null,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        latitude: input.latitude?.toString() ?? null,
        longitude: input.longitude?.toString() ?? null,
        baseCurrency: input.baseCurrency ?? 'INR',
        tripMode: input.tripMode,
        mainVariantId: variantId,
      });

      await tx.insert(variants).values({
        id: variantId,
        tripId,
        name: 'Main',
        isMain: true,
        createdBy: userId,
      });

      await tx.insert(tripMembers).values({ tripId, userId, role: 'OWNER' });

      // The owner is a ledger participant from the start, so the first expense
      // does not need a separate setup step.
      await tx.insert(tripParticipants).values({
        id: newId(),
        tripId,
        userId,
        displayName: 'You',
        createdBy: userId,
      });

      // An EXPENSES_ONLY trip has no canvas, so it gets no days (FR-SPLIT-46).
      if (input.tripMode === 'FULL' && input.startDate && input.endDate) {
        const dayRows = this.buildDays(variantId, input.startDate, input.endDate);
        if (dayRows.length > limits.daysPerVariant) {
          throw new LimitExceededError('days on a trip', limits.daysPerVariant);
        }
        if (dayRows.length > 0) await tx.insert(days).values(dayRows);
      }

      await this.deps.activity.record(tx, {
        tripId,
        actorId: userId,
        kind: 'trip.created',
        entityType: 'trip',
        entityId: tripId,
        after: { title: input.title ?? input.destination, tripMode: input.tripMode },
      });
    });

    return this.get(userId, tripId);
  }

  private buildDays(
    variantId: string,
    startDate: string,
    endDate: string,
  ): (typeof days.$inferInsert)[] {
    const start = parseISO(startDate);
    const total = differenceInCalendarDays(parseISO(endDate), start) + 1;
    if (total <= 0) return [];

    return Array.from({ length: total }, (_, index) => ({
      id: newId(),
      variantId,
      dayNumber: index + 1,
      date: formatISO(addDays(start, index)),
      title: '',
      note: '',
      status: 'PLANNING' as const,
    }));
  }

  // ── Update, including the date-change contract ────────────────────

  async update(access: TripAccess, input: UpdateTripBody): Promise<TripListRow> {
    const broadcast = new DeferredBroadcast();

    await withTransaction(async (tx) => {
      const current = await this.deps.trips.findById(tx, access.tripId);
      if (!current) throw new NotFoundError('Trip');

      if (input.folderId) {
        const owned = await this.deps.folders.belongsTo(tx, input.folderId, access.userId);
        if (!owned) throw new NotFoundError('Folder');
      }

      const datesChanged =
        (input.startDate !== undefined && input.startDate !== current.startDate) ||
        (input.endDate !== undefined && input.endDate !== current.endDate);

      if (datesChanged && current.mainVariantId) {
        await this.applyDateChange(tx, current, input, access.userId);
      }

      const patch: Partial<typeof trips.$inferInsert> = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.subtitle !== undefined) patch.subtitle = input.subtitle;
      if (input.destination !== undefined) patch.destination = input.destination;
      if (input.startDate !== undefined) patch.startDate = input.startDate;
      if (input.endDate !== undefined) patch.endDate = input.endDate;
      if (input.status !== undefined) patch.status = input.status;
      if (input.folderId !== undefined) patch.folderId = input.folderId;
      if (input.baseCurrency !== undefined) patch.baseCurrency = input.baseCurrency;
      if (input.simplifyDebts !== undefined) patch.simplifyDebts = input.simplifyDebts;

      await this.deps.trips.update(tx, access.tripId, input.version, patch);

      await this.deps.activity.record(tx, {
        tripId: access.tripId,
        actorId: access.userId,
        kind: 'trip.updated',
        entityType: 'trip',
        entityId: access.tripId,
        before: { title: current.title, startDate: current.startDate, endDate: current.endDate },
        after: patch,
      });

      broadcast.queue({
        kind: 'trip.updated',
        tripId: access.tripId,
        entityId: access.tripId,
        actorId: access.userId,
      });
    });

    broadcast.flush();
    return this.get(access.userId, access.tripId);
  }

  /**
   * FR-TRIP-14 — the server never guesses what should happen to existing days.
   */
  private async applyDateChange(
    tx: Executor,
    current: { id: string; mainVariantId: string | null; startDate: string | null },
    input: UpdateTripBody,
    userId: string,
  ): Promise<void> {
    const variantId = current.mainVariantId!;
    const currentDayCount = await this.deps.trips.countDays(tx, variantId);

    const nextStart = input.startDate ?? current.startDate;
    const nextEnd = input.endDate;
    const requestedDayCount =
      nextStart && nextEnd
        ? differenceInCalendarDays(parseISO(nextEnd), parseISO(nextStart)) + 1
        : currentDayCount;

    if (currentDayCount === 0) return;

    const strategy: DateChangeStrategy | undefined = input.dateChangeStrategy;

    if (!strategy && requestedDayCount !== currentDayCount) {
      throw new DateChangeStrategyRequiredError({ currentDayCount, requestedDayCount });
    }

    switch (strategy ?? 'SHIFT') {
      case 'KEEP_DAYS':
        // Dates change; day structure untouched. Days become undated.
        await tx.update(days).set({ date: null }).where(eq(days.variantId, variantId));
        break;

      case 'SHIFT': {
        if (!nextStart) break;
        const start = parseISO(nextStart);
        await tx.execute(sql`
          update ${days}
             set date = (${formatISO(start)}::date + (day_number - 1))
           where variant_id = ${variantId}
        `);
        break;
      }

      case 'TRUNCATE': {
        if (requestedDayCount >= currentDayCount) break;
        // Soft-delete the blocks first so the removal is undoable, then drop
        // the days themselves.
        await tx.execute(sql`
          update ${blocks} set deleted_at = now()
           where day_id in (
             select id from ${days}
              where variant_id = ${variantId} and day_number > ${requestedDayCount})
        `);
        await tx.execute(sql`
          delete from ${days}
           where variant_id = ${variantId} and day_number > ${requestedDayCount}
        `);
        break;
      }

      case 'EXTEND': {
        if (requestedDayCount <= currentDayCount || !nextStart) break;
        const start = parseISO(nextStart);
        const extra = Array.from(
          { length: requestedDayCount - currentDayCount },
          (_, index) => {
            const dayNumber = currentDayCount + index + 1;
            return {
              id: newId(),
              variantId,
              dayNumber,
              date: formatISO(addDays(start, dayNumber - 1)),
              title: '',
              note: '',
              status: 'PLANNING' as const,
            };
          },
        );
        await tx.insert(days).values(extra);
        break;
      }

      default:
        break;
    }

    await this.deps.activity.record(tx, {
      tripId: current.id,
      actorId: userId,
      kind: 'trip.dates-changed',
      entityType: 'trip',
      entityId: current.id,
      after: { strategy: strategy ?? 'SHIFT', currentDayCount, requestedDayCount },
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async archive(access: TripAccess, archived: boolean): Promise<void> {
    await withTransaction(async (tx) => {
      await this.deps.trips.setArchived(tx, access.tripId, archived);
      await this.deps.activity.record(tx, {
        tripId: access.tripId,
        actorId: access.userId,
        kind: archived ? 'trip.archived' : 'trip.unarchived',
        entityType: 'trip',
        entityId: access.tripId,
      });
    });
  }

  async remove(access: TripAccess): Promise<void> {
    await withTransaction(async (tx) => {
      const deleted = await this.deps.trips.softDelete(tx, access.tripId);
      if (!deleted) throw new NotFoundError('Trip');

      await this.deps.activity.record(tx, {
        tripId: access.tripId,
        actorId: access.userId,
        kind: 'trip.deleted',
        entityType: 'trip',
        entityId: access.tripId,
      });
    });
  }

  /**
   * Restore a soft-deleted trip.
   *
   * `withTripAccess` cannot guard this route — the access loader filters out
   * soft-deleted trips, so it would 404 before the handler runs. Ownership is
   * therefore checked HERE, against the deleted row, and nowhere else.
   */
  async restore(userId: string, tripId: string): Promise<void> {
    const rows = await db
      .select({ id: trips.id, ownerId: trips.ownerId, deletedAt: trips.deletedAt })
      .from(trips)
      .where(eq(trips.id, tripId))
      .limit(1);

    const trip = rows[0];

    // 404 rather than 403 for someone else's trip: never an existence oracle.
    if (!trip || trip.ownerId !== userId) throw new NotFoundError('Trip');
    if (!trip.deletedAt) return; // already live — idempotent

    await this.deps.trips.restore(db, tripId);

    await this.deps.activity.record(db, {
      tripId,
      actorId: userId,
      kind: 'trip.restored',
      entityType: 'trip',
      entityId: tripId,
    });
  }

  async setPinned(access: TripAccess, pinned: boolean): Promise<void> {
    await this.deps.trips.setPinned(db, access.tripId, access.userId, pinned);
  }

  async reorder(userId: string, orderedTripIds: string[]): Promise<void> {
    await this.deps.trips.setOrder(db, userId, orderedTripIds);
  }

  /**
   * FR-TRIP-07 / FR-SPLIT-45 — deep-copies the itinerary; copies NO memberships,
   * comments, activity, share links, or expenses. A duplicated plan starts with
   * an empty ledger, because money that changed hands did not change hands twice.
   */
  async duplicate(access: TripAccess): Promise<TripListRow> {
    const newTripId = newId();

    await withTransaction(async (tx) => {
      const source = await this.deps.trips.findById(tx, access.tripId);
      if (!source) throw new NotFoundError('Trip');

      const sourceVariants = await tx
        .select()
        .from(variants)
        .where(eq(variants.tripId, access.tripId));

      const variantIdMap = new Map<string, string>();
      for (const variant of sourceVariants) variantIdMap.set(variant.id, newId());

      await this.deps.trips.create(tx, {
        id: newTripId,
        ownerId: access.userId,
        folderId: source.folderId,
        title: `${source.title} · copy`,
        subtitle: source.subtitle,
        destination: source.destination,
        placeId: source.placeId,
        startDate: source.startDate,
        endDate: source.endDate,
        latitude: source.latitude,
        longitude: source.longitude,
        status: 'DRAFT',
        tripMode: source.tripMode,
        baseCurrency: source.baseCurrency,
        simplifyDebts: source.simplifyDebts,
        coverAssetId: source.coverAssetId,
        coverHue: source.coverHue,
        coverHue2: source.coverHue2,
        mainVariantId: source.mainVariantId
          ? (variantIdMap.get(source.mainVariantId) ?? null)
          : null,
      });

      for (const variant of sourceVariants) {
        const targetVariantId = variantIdMap.get(variant.id)!;

        await tx.insert(variants).values({
          id: targetVariantId,
          tripId: newTripId,
          name: variant.name,
          isMain: variant.isMain,
          createdBy: access.userId,
        });

        await this.copyDaysAndBlocks(tx, variant.id, targetVariantId, access.userId);
      }

      await tx.insert(tripMembers).values({
        tripId: newTripId,
        userId: access.userId,
        role: 'OWNER',
      });

      await tx.insert(tripParticipants).values({
        id: newId(),
        tripId: newTripId,
        userId: access.userId,
        displayName: 'You',
        createdBy: access.userId,
      });

      await this.deps.activity.record(tx, {
        tripId: newTripId,
        actorId: access.userId,
        kind: 'trip.duplicated',
        entityType: 'trip',
        entityId: newTripId,
        after: { sourceTripId: access.tripId },
      });
    });

    return this.get(access.userId, newTripId);
  }

  /**
   * Deep-copy one variant's day/block tree.
   *
   * Shared with variant forking (FR-VAR-03), which is the same operation within
   * a single trip — the prototype never implemented either.
   */
  async copyDaysAndBlocks(
    tx: Executor,
    sourceVariantId: string,
    targetVariantId: string,
    actorId: string,
  ): Promise<void> {
    const sourceDays = await tx
      .select()
      .from(days)
      .where(eq(days.variantId, sourceVariantId));

    for (const day of sourceDays) {
      const targetDayId = newId();

      await tx.insert(days).values({
        id: targetDayId,
        variantId: targetVariantId,
        dayNumber: day.dayNumber,
        date: day.date,
        title: day.title,
        note: day.note,
        status: day.status,
        weatherCache: day.weatherCache,
      });

      const sourceBlocks = await tx
        .select()
        .from(blocks)
        .where(sql`${blocks.dayId} = ${day.id} and ${blocks.deletedAt} is null`);

      if (sourceBlocks.length === 0) continue;

      await tx.insert(blocks).values(
        sourceBlocks.map((block) => ({
          id: newId(),
          dayId: targetDayId,
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
          createdBy: actorId,
        })),
      );
    }
  }

  // ── Folders ───────────────────────────────────────────────────────

  async listFolders(userId: string) {
    return this.deps.folders.listForUser(db, userId);
  }

  async createFolder(userId: string, input: CreateFolderBody) {
    return this.deps.folders.create(db, {
      id: newId(),
      ownerId: userId,
      name: input.name,
      emoji: input.emoji,
      tone: input.tone,
    });
  }

  async updateFolder(
    userId: string,
    folderId: string,
    patch: Partial<CreateFolderBody> & { isPinned?: boolean; sortOrder?: number },
  ) {
    const owned = await this.deps.folders.belongsTo(db, folderId, userId);
    if (!owned) throw new NotFoundError('Folder');

    const updated = await this.deps.folders.update(db, folderId, patch);
    if (!updated) throw new NotFoundError('Folder');
    return updated;
  }

  /**
   * FR-FOLD-06 — deleting a folder does NOT delete its trips. They become
   * unfiled via ON DELETE SET NULL. The count is returned so the client can
   * have said so before confirming.
   */
  async deleteFolder(userId: string, folderId: string): Promise<{ unfiledTrips: number }> {
    const owned = await this.deps.folders.belongsTo(db, folderId, userId);
    if (!owned) throw new NotFoundError('Folder');

    const unfiledTrips = await this.deps.folders.countTrips(db, folderId);
    await this.deps.folders.hardDelete(db, folderId);
    return { unfiledTrips };
  }

  async moveToFolder(access: TripAccess, folderId: string | null): Promise<void> {
    if (folderId) {
      const owned = await this.deps.folders.belongsTo(db, folderId, access.userId);
      if (!owned) throw new NotFoundError('Folder');
    }

    const current = await this.deps.trips.findById(db, access.tripId);
    if (!current) throw new NotFoundError('Trip');

    // Shared trips are unfiled for the recipient; only the owner files a trip.
    if (current.ownerId !== access.userId) {
      throw new DomainRuleError(
        'Only the trip owner can move it into a folder. Duplicate it to file your own copy.',
      );
    }

    await db.update(trips).set({ folderId }).where(eq(trips.id, access.tripId));
  }
}

export const tripsService = new TripsService({
  trips: new TripRepository(),
  folders: new FolderRepository(),
  activity: activityService,
});
