/**
 * Canvas data access — variants, days, blocks.
 *
 * The `*InTrip` lookups exist so the service can verify a resource belongs to
 * the caller's trip in a single query. Without them, a valid token for trip A
 * could reach a block in trip B by guessing its id.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type { Executor } from '../../platform/db/index';
import {
  blocks,
  days,
  variants,
  type BlockRow,
  type DayRow,
  type VariantRow,
} from '../../platform/db/schema/index';

export interface VariantWithCounts extends VariantRow {
  dayCount: number;
  blockCount: number;
}

export interface DayWithBlocks extends DayRow {
  blocks: BlockRow[];
}

export class CanvasRepository {
  // ── Variants ──────────────────────────────────────────────────────

  async findVariant(exec: Executor, id: string): Promise<VariantRow | null> {
    const rows = await exec.select().from(variants).where(eq(variants.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async mainVariant(exec: Executor, tripId: string): Promise<VariantWithCounts | null> {
    const list = await this.listVariants(exec, tripId);
    return list.find((variant) => variant.isMain) ?? list[0] ?? null;
  }

  async listVariants(exec: Executor, tripId: string): Promise<VariantWithCounts[]> {
    // Table-qualified by hand: Drizzle only auto-qualifies inside a raw `sql`
    // template when the outer query has a JOIN, and this one has none.
    const rows = await exec
      .select({
        variant: variants,
        dayCount: sql<number>`(
          select count(*)::int from days vd where vd.variant_id = variants.id)`,
        blockCount: sql<number>`(
          select count(*)::int
            from blocks vb
            join days vbd on vbd.id = vb.day_id
           where vbd.variant_id = variants.id and vb.deleted_at is null)`,
      })
      .from(variants)
      .where(eq(variants.tripId, tripId))
      .orderBy(sql`${variants.isMain} desc`, asc(variants.createdAt));

    return rows.map((row) => ({
      ...row.variant,
      dayCount: Number(row.dayCount),
      blockCount: Number(row.blockCount),
    }));
  }

  async countVariants(exec: Executor, tripId: string): Promise<number> {
    const [row] = await exec
      .select({ count: sql<number>`count(*)::int` })
      .from(variants)
      .where(eq(variants.tripId, tripId));
    return row?.count ?? 0;
  }

  // ── Days ──────────────────────────────────────────────────────────

  async findDay(exec: Executor, id: string): Promise<DayRow | null> {
    const rows = await exec.select().from(days).where(eq(days.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /** Day lookup scoped to a trip, via its variant. */
  async findDayInTrip(exec: Executor, tripId: string, dayId: string): Promise<DayRow | null> {
    const rows = await exec
      .select({ day: days })
      .from(days)
      .innerJoin(variants, eq(variants.id, days.variantId))
      .where(and(eq(days.id, dayId), eq(variants.tripId, tripId)))
      .limit(1);
    return rows[0]?.day ?? null;
  }

  async countDays(exec: Executor, variantId: string): Promise<number> {
    const [row] = await exec
      .select({ count: sql<number>`count(*)::int` })
      .from(days)
      .where(eq(days.variantId, variantId));
    return row?.count ?? 0;
  }

  /**
   * The canvas read: every day with its blocks, in two queries rather than
   * one-per-day. At 90 days × 200 blocks that difference is the whole latency
   * budget.
   */
  async daysWithBlocks(exec: Executor, variantId: string): Promise<DayWithBlocks[]> {
    const dayRows = await exec
      .select()
      .from(days)
      .where(eq(days.variantId, variantId))
      .orderBy(asc(days.dayNumber));

    if (dayRows.length === 0) return [];

    const blockRows = await exec
      .select()
      .from(blocks)
      .where(
        and(
          sql`${blocks.dayId} in (${sql.join(
            dayRows.map((day) => sql`${day.id}::uuid`),
            sql`, `,
          )})`,
          isNull(blocks.deletedAt),
        ),
      )
      .orderBy(asc(blocks.sortOrder));

    const byDay = new Map<string, BlockRow[]>();
    for (const block of blockRows) {
      const list = byDay.get(block.dayId) ?? [];
      list.push(block);
      byDay.set(block.dayId, list);
    }

    return dayRows.map((day) => ({ ...day, blocks: byDay.get(day.id) ?? [] }));
  }

  // ── Blocks ────────────────────────────────────────────────────────

  async findBlock(exec: Executor, id: string): Promise<BlockRow | null> {
    const rows = await exec
      .select()
      .from(blocks)
      .where(and(eq(blocks.id, id), isNull(blocks.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Block lookup scoped to a trip, via day → variant. */
  async findBlockInTrip(
    exec: Executor,
    tripId: string,
    blockId: string,
  ): Promise<BlockRow | null> {
    const rows = await exec
      .select({ block: blocks })
      .from(blocks)
      .innerJoin(days, eq(days.id, blocks.dayId))
      .innerJoin(variants, eq(variants.id, days.variantId))
      .where(
        and(
          eq(blocks.id, blockId),
          eq(variants.tripId, tripId),
          isNull(blocks.deletedAt),
        ),
      )
      .limit(1);
    return rows[0]?.block ?? null;
  }

  async countBlocks(exec: Executor, dayId: string): Promise<number> {
    const [row] = await exec
      .select({ count: sql<number>`count(*)::int` })
      .from(blocks)
      .where(and(eq(blocks.dayId, dayId), isNull(blocks.deletedAt)));
    return row?.count ?? 0;
  }

  async maxSortOrder(exec: Executor, dayId: string): Promise<number> {
    const [row] = await exec
      .select({ max: sql<number>`coalesce(max(${blocks.sortOrder}), 0)::int` })
      .from(blocks)
      .where(and(eq(blocks.dayId, dayId), isNull(blocks.deletedAt)));
    return row?.max ?? 0;
  }
}
