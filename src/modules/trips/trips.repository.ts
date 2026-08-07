/**
 * Trip data access.
 *
 * The interesting query here is `listForUser`: it computes day/block/variant
 * counts and readiness in SQL rather than storing them, because the prototype
 * stored them and they drifted from the canvas immediately (PRD §6.2).
 */

import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import { BaseRepository } from '../../platform/db/BaseRepository';
import type { Executor } from '../../platform/db/index';
import {
  blocks,
  days,
  folders,
  tripMembers,
  tripUserState,
  trips,
  variants,
  type FolderRow,
  type TripRow,
} from '../../platform/db/schema/index';

/** Block types that carry a booked/open state and drive readiness (FR-DASH-07). */
const BOOKABLE = ['ACCOMMODATION', 'TRANSPORT', 'RESTAURANT', 'TICKET'] as const;

export interface TripListRow extends TripRow {
  role: string;
  isPinned: boolean;
  userSortOrder: number;
  dayCount: number;
  blockCount: number;
  variantCount: number;
  memberCount: number;
  bookableBlockCount: number;
  confirmedBlockCount: number;
}

export type TripView = 'dashboard' | 'shared' | 'archive' | 'folder';

export class TripRepository extends BaseRepository<TripRow> {
  constructor() {
    super(trips, true);
  }

  async create(exec: Executor, row: typeof trips.$inferInsert): Promise<TripRow> {
    const [created] = await exec.insert(trips).values(row).returning();
    return created!;
  }

  async update(
    exec: Executor,
    id: string,
    expectedVersion: number,
    patch: Partial<typeof trips.$inferInsert>,
  ): Promise<TripRow> {
    return this.updateVersioned(exec, id, expectedVersion, patch);
  }

  /**
   * The dashboard query.
   *
   * Correlated subqueries rather than joins: a trip has few days and blocks, and
   * this keeps the row count honest without a GROUP BY over the whole tree.
   * At this scale it is single-digit milliseconds.
   */
  async listForUser(
    exec: Executor,
    userId: string,
    options: { view: TripView; folderId?: string; search?: string },
  ): Promise<TripListRow[]> {
    const conditions: SQL[] = [
      eq(tripMembers.userId, userId),
      isNull(trips.deletedAt),
    ];

    switch (options.view) {
      case 'archive':
        conditions.push(eq(trips.isArchived, true));
        break;
      case 'shared':
        // Trips someone else owns (FR-COLLAB-11).
        conditions.push(eq(trips.isArchived, false));
        conditions.push(sql`${trips.ownerId} <> ${userId}`);
        break;
      case 'folder':
        conditions.push(eq(trips.isArchived, false));
        conditions.push(
          options.folderId
            ? eq(trips.folderId, options.folderId)
            : isNull(trips.folderId),
        );
        break;
      default:
        conditions.push(eq(trips.isArchived, false));
        break;
    }

    if (options.search) {
      const pattern = `%${options.search}%`;
      conditions.push(
        sql`(${trips.title} ilike ${pattern}
          or ${trips.destination} ilike ${pattern}
          or ${trips.subtitle} ilike ${pattern})`,
      );
    }

    const mainVariantBlocks = sql`
      select b.id, b.type, b.is_confirmed
        from ${blocks} b
        join ${days} d on d.id = b.day_id
       where d.variant_id = ${trips.mainVariantId}
         and b.deleted_at is null
    `;

    const rows = await exec
      .select({
        trip: trips,
        role: tripMembers.role,
        isPinned: sql<boolean>`coalesce(${tripUserState.isPinned}, false)`,
        userSortOrder: sql<number>`coalesce(${tripUserState.sortOrder}, 0)`,
        dayCount: sql<number>`(
          select count(*)::int from ${days}
           where ${days.variantId} = ${trips.mainVariantId})`,
        blockCount: sql<number>`(select count(*)::int from (${mainVariantBlocks}) mb)`,
        variantCount: sql<number>`(
          select count(*)::int from ${variants} where ${variants.tripId} = ${trips.id})`,
        memberCount: sql<number>`(
          select count(*)::int from ${tripMembers} tm where tm.trip_id = ${trips.id})`,
        bookableBlockCount: sql<number>`(
          select count(*)::int from (${mainVariantBlocks}) mb
           where mb.type = any(${sql.raw(`array['${BOOKABLE.join("','")}']::block_type[]`)}))`,
        confirmedBlockCount: sql<number>`(
          select count(*)::int from (${mainVariantBlocks}) mb
           where mb.is_confirmed
             and mb.type = any(${sql.raw(`array['${BOOKABLE.join("','")}']::block_type[]`)}))`,
      })
      .from(trips)
      .innerJoin(tripMembers, eq(tripMembers.tripId, trips.id))
      .leftJoin(
        tripUserState,
        and(eq(tripUserState.tripId, trips.id), eq(tripUserState.userId, userId)),
      )
      .where(and(...conditions))
      .orderBy(
        sql`coalesce(${tripUserState.isPinned}, false) desc`,
        asc(sql`coalesce(${tripUserState.sortOrder}, 0)`),
        asc(trips.createdAt),
      );

    return rows.map((row) => ({
      ...row.trip,
      role: row.role,
      isPinned: row.isPinned,
      userSortOrder: row.userSortOrder,
      dayCount: Number(row.dayCount),
      blockCount: Number(row.blockCount),
      variantCount: Number(row.variantCount),
      memberCount: Number(row.memberCount),
      bookableBlockCount: Number(row.bookableBlockCount),
      confirmedBlockCount: Number(row.confirmedBlockCount),
    }));
  }

  /** Single trip with the same derived counts as the list view. */
  async findForUser(
    exec: Executor,
    userId: string,
    tripId: string,
  ): Promise<TripListRow | null> {
    const rows = await this.listForUser(exec, userId, { view: 'dashboard' });
    const match = rows.find((row) => row.id === tripId);
    if (match) return match;

    // Not in the dashboard view (archived, or owned by someone else) — widen.
    for (const view of ['archive', 'shared'] as const) {
      const wider = await this.listForUser(exec, userId, { view });
      const found = wider.find((row) => row.id === tripId);
      if (found) return found;
    }

    return null;
  }

  async setArchived(exec: Executor, id: string, archived: boolean): Promise<void> {
    await exec
      .update(trips)
      .set({ isArchived: archived, archivedAt: archived ? new Date() : null })
      .where(eq(trips.id, id));
  }

  /** Per-user pin state (FR-TRIP-06) — never a column on the trip. */
  async setPinned(
    exec: Executor,
    tripId: string,
    userId: string,
    pinned: boolean,
  ): Promise<void> {
    await exec
      .insert(tripUserState)
      .values({ tripId, userId, isPinned: pinned })
      .onConflictDoUpdate({
        target: [tripUserState.tripId, tripUserState.userId],
        set: { isPinned: pinned },
      });
  }

  async setOrder(exec: Executor, userId: string, orderedTripIds: string[]): Promise<void> {
    if (orderedTripIds.length === 0) return;

    await exec
      .insert(tripUserState)
      .values(
        orderedTripIds.map((tripId, index) => ({ tripId, userId, sortOrder: index })),
      )
      .onConflictDoUpdate({
        target: [tripUserState.tripId, tripUserState.userId],
        set: { sortOrder: sql`excluded.sort_order` },
      });
  }

  async countDays(exec: Executor, variantId: string): Promise<number> {
    const [row] = await exec
      .select({ count: sql<number>`count(*)::int` })
      .from(days)
      .where(eq(days.variantId, variantId));
    return row?.count ?? 0;
  }

  /** Trips this user owns, for the account-deletion flow (FR-AUTH-07). */
  async ownedBy(exec: Executor, userId: string): Promise<TripRow[]> {
    return exec
      .select()
      .from(trips)
      .where(and(eq(trips.ownerId, userId), isNull(trips.deletedAt)));
  }
}

export class FolderRepository extends BaseRepository<FolderRow> {
  constructor() {
    super(folders, false);
  }

  async create(exec: Executor, row: typeof folders.$inferInsert): Promise<FolderRow> {
    const [created] = await exec.insert(folders).values(row).returning();
    return created!;
  }

  async listForUser(
    exec: Executor,
    userId: string,
  ): Promise<(FolderRow & { tripCount: number })[]> {
    const rows = await exec
      .select({
        folder: folders,
        // Counts exclude archived and deleted trips (FR-FOLD-05).
        //
        // Table-qualified by hand: Drizzle only auto-qualifies columns inside a
        // raw `sql` template when the outer query has a JOIN. Without one it
        // emits bare names, which bind to the SUBQUERY's table — silently
        // comparing trips.folder_id to trips.id and always counting zero.
        tripCount: sql<number>`(
          select count(*)::int
            from trips ft
           where ft.folder_id = folders.id
             and ft.deleted_at is null
             and ft.is_archived = false)`,
      })
      .from(folders)
      .where(eq(folders.ownerId, userId))
      .orderBy(asc(folders.sortOrder), asc(folders.createdAt));

    return rows.map((row) => ({ ...row.folder, tripCount: Number(row.tripCount) }));
  }

  async update(
    exec: Executor,
    id: string,
    patch: Partial<typeof folders.$inferInsert>,
  ): Promise<FolderRow | null> {
    const [updated] = await exec
      .update(folders)
      .set(patch)
      .where(eq(folders.id, id))
      .returning();
    return updated ?? null;
  }

  /**
   * Deleting a folder does NOT delete its trips (FR-FOLD-06) — the FK is
   * ON DELETE SET NULL, so they become unfiled. Returns how many were affected
   * so the caller can tell the user before confirming.
   */
  async countTrips(exec: Executor, folderId: string): Promise<number> {
    const [row] = await exec
      .select({ count: sql<number>`count(*)::int` })
      .from(trips)
      .where(and(eq(trips.folderId, folderId), isNull(trips.deletedAt)));
    return row?.count ?? 0;
  }

  async belongsTo(exec: Executor, folderId: string, userId: string): Promise<boolean> {
    const rows = await exec
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.id, folderId), eq(folders.ownerId, userId)))
      .limit(1);
    return rows.length > 0;
  }

  async idsOwnedBy(exec: Executor, userId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await exec
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.ownerId, userId), inArray(folders.id, ids)));
    return new Set(rows.map((row) => row.id));
  }
}
