/**
 * Packing list and trip notes — the two shared side-panels.
 *
 * Both are TRIP-scoped and collaborative, not per-user. The prototype kept
 * notes in `localStorage`, which meant collaborators could not see them and
 * they vanished on a device change (FR-PANEL-10).
 */

import { and, asc, eq, sql } from 'drizzle-orm';

import { newId } from '../../platform/crypto/index';
import { db, withTransaction } from '../../platform/db/index';
import { packingItems, tripNotes, users } from '../../platform/db/schema/index';
import { NotFoundError, StaleWriteError } from '../../platform/errors/AppError';
import { DeferredBroadcast } from '../../platform/realtime/hub';
import type { TripAccess } from '../../platform/policy/index';

/**
 * FR-PANEL-08 — a starter list, so the panel is not an empty box.
 *
 * Deliberately generic rather than "smart": adapting to destination climate and
 * block types is a Should, and a wrong guess is more annoying than a plain list.
 */
const STARTER_LIST: { category: string; label: string }[] = [
  { category: 'Documents', label: 'Passport' },
  { category: 'Documents', label: 'Travel insurance' },
  { category: 'Documents', label: 'Booking confirmations' },
  { category: 'Clothes', label: 'Layers' },
  { category: 'Clothes', label: 'Rain shell' },
  { category: 'Clothes', label: 'Walking shoes (broken in)' },
  { category: 'Electronics', label: 'Charger' },
  { category: 'Electronics', label: 'Power bank' },
  { category: 'Electronics', label: 'Universal adapter' },
  { category: 'Toiletries', label: 'Medication' },
  { category: 'Toiletries', label: 'Sunscreen' },
];

export class PanelsService {
  // ── Packing ───────────────────────────────────────────────────────

  async listPacking(access: TripAccess) {
    const rows = await db
      .select({
        item: packingItems,
        checkedByName: sql<string | null>`(
          select display_name from users where users.id = packing_items.checked_by)`,
      })
      .from(packingItems)
      .where(eq(packingItems.tripId, access.tripId))
      .orderBy(asc(packingItems.category), asc(packingItems.sortOrder), asc(packingItems.createdAt));

    return {
      items: rows,
      packedCount: rows.filter((row) => row.item.isChecked).length,
      totalCount: rows.length,
    };
  }

  async addPackingItem(access: TripAccess, input: { category: string; label: string }) {
    const [maxRow] = await db
      .select({ max: sql<number>`coalesce(max(${packingItems.sortOrder}), 0)::int` })
      .from(packingItems)
      .where(and(eq(packingItems.tripId, access.tripId), eq(packingItems.category, input.category)));

    const [created] = await db
      .insert(packingItems)
      .values({
        id: newId(),
        tripId: access.tripId,
        category: input.category,
        label: input.label,
        sortOrder: (maxRow?.max ?? 0) + 1,
        createdBy: access.userId,
      })
      .returning();

    this.broadcast(access, 'packing.updated');
    return created!;
  }

  async updatePackingItem(
    access: TripAccess,
    itemId: string,
    patch: { label?: string; category?: string; isChecked?: boolean },
  ) {
    const existing = await this.requireItem(access.tripId, itemId);

    const update: Record<string, unknown> = {};
    if (patch.label !== undefined) update.label = patch.label;
    if (patch.category !== undefined) update.category = patch.category;

    // FR-PANEL-07 — who packed it, not just that it is packed.
    if (patch.isChecked !== undefined && patch.isChecked !== existing.isChecked) {
      update.isChecked = patch.isChecked;
      update.checkedBy = patch.isChecked ? access.userId : null;
      update.checkedAt = patch.isChecked ? new Date() : null;
    }

    if (Object.keys(update).length === 0) return existing;

    const [updated] = await db
      .update(packingItems)
      .set(update)
      .where(eq(packingItems.id, itemId))
      .returning();

    this.broadcast(access, 'packing.updated');
    return updated!;
  }

  async deletePackingItem(access: TripAccess, itemId: string): Promise<void> {
    await this.requireItem(access.tripId, itemId);
    await db.delete(packingItems).where(eq(packingItems.id, itemId));
    this.broadcast(access, 'packing.updated');
  }

  /** Seed the starter list. `replace` clears anything already there. */
  async seedPacking(access: TripAccess, replace: boolean) {
    await withTransaction(async (tx) => {
      if (replace) {
        await tx.delete(packingItems).where(eq(packingItems.tripId, access.tripId));
      } else {
        const [existing] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(packingItems)
          .where(eq(packingItems.tripId, access.tripId));
        // Non-destructive by default: seeding an in-progress list would be rude.
        if ((existing?.count ?? 0) > 0) return;
      }

      await tx.insert(packingItems).values(
        STARTER_LIST.map((entry, index) => ({
          id: newId(),
          tripId: access.tripId,
          category: entry.category,
          label: entry.label,
          isTemplate: true,
          sortOrder: index,
          createdBy: access.userId,
        })),
      );
    });

    this.broadcast(access, 'packing.updated');
    return this.listPacking(access);
  }

  // ── Trip notes ────────────────────────────────────────────────────

  async getNotes(access: TripAccess) {
    const rows = await db
      .select({
        note: tripNotes,
        updatedByName: sql<string | null>`(
          select display_name from users where users.id = trip_notes.updated_by)`,
      })
      .from(tripNotes)
      .where(eq(tripNotes.tripId, access.tripId))
      .limit(1);

    // Lazily materialised: an untouched trip has no row, which is not an error.
    return (
      rows[0] ?? {
        note: {
          tripId: access.tripId,
          body: '',
          version: 1,
          updatedBy: null,
          updatedAt: new Date(),
        },
        updatedByName: null,
      }
    );
  }

  /**
   * Shared notes need optimistic locking: two people editing the same
   * scratchpad is the expected case, not an edge case.
   */
  async updateNotes(access: TripAccess, body: string, version: number) {
    const existing = await db
      .select({ version: tripNotes.version })
      .from(tripNotes)
      .where(eq(tripNotes.tripId, access.tripId))
      .limit(1);

    if (existing.length === 0) {
      if (version !== 1) throw new StaleWriteError(await this.getNotes(access));

      await db.insert(tripNotes).values({
        tripId: access.tripId,
        body,
        version: 2,
        updatedBy: access.userId,
      });
    } else {
      const [updated] = await db
        .update(tripNotes)
        .set({
          body,
          version: sql`${tripNotes.version} + 1`,
          updatedBy: access.userId,
          updatedAt: new Date(),
        })
        .where(and(eq(tripNotes.tripId, access.tripId), eq(tripNotes.version, version)))
        .returning();

      if (!updated) throw new StaleWriteError(await this.getNotes(access));
    }

    this.broadcast(access, 'notes.updated');
    return this.getNotes(access);
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async requireItem(tripId: string, itemId: string) {
    const rows = await db
      .select()
      .from(packingItems)
      .where(and(eq(packingItems.id, itemId), eq(packingItems.tripId, tripId)))
      .limit(1);

    const item = rows[0];
    if (!item) throw new NotFoundError('Packing item');
    return item;
  }

  private broadcast(access: TripAccess, kind: 'packing.updated' | 'notes.updated'): void {
    const broadcast = new DeferredBroadcast();
    broadcast.queue({ kind, tripId: access.tripId, actorId: access.userId });
    broadcast.flush();
  }
}

export const panelsService = new PanelsService();
void users;
