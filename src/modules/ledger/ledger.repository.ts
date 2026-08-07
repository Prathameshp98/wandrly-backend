/**
 * Ledger data access.
 *
 * TECHNICAL_DESIGN §5.3, §5.4. All monetary columns are BIGINT minor units and
 * come back as `bigint` — never `number`.
 */

import { and, desc, eq, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';

import { BaseRepository } from '../../platform/db/BaseRepository';
import type { Executor } from '../../platform/db/index';
import {
  expensePayments,
  expenseShares,
  expenses,
  settlements,
  tripParticipants,
  type ExpenseRow,
  type SettlementRow,
  type TripParticipantRow,
} from '../../platform/db/schema/index';

export interface BalanceRow {
  participantId: string;
  displayName: string;
  isPlaceholder: boolean;
  paidMinor: bigint;
  owedMinor: bigint;
  sentMinor: bigint;
  receivedMinor: bigint;
  netMinor: bigint;
}

export interface ExpenseWithRelations {
  expense: ExpenseRow;
  payments: { participantId: string; amountMinor: bigint; amountBaseMinor: bigint }[];
  shares: {
    participantId: string;
    shareAmountMinor: bigint;
    shareAmountBaseMinor: bigint;
  }[];
}

export class ParticipantRepository extends BaseRepository<TripParticipantRow> {
  constructor() {
    super(tripParticipants, false);
  }

  async listByTrip(exec: Executor, tripId: string, includeInactive = false): Promise<TripParticipantRow[]> {
    const predicate = includeInactive
      ? eq(tripParticipants.tripId, tripId)
      : and(eq(tripParticipants.tripId, tripId), eq(tripParticipants.isActive, true));

    return exec
      .select()
      .from(tripParticipants)
      .where(predicate)
      .orderBy(tripParticipants.createdAt);
  }

  async findByUser(
    exec: Executor,
    tripId: string,
    userId: string,
  ): Promise<TripParticipantRow | null> {
    const rows = await exec
      .select()
      .from(tripParticipants)
      .where(and(eq(tripParticipants.tripId, tripId), eq(tripParticipants.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async create(
    exec: Executor,
    row: typeof tripParticipants.$inferInsert,
  ): Promise<TripParticipantRow> {
    const [created] = await exec.insert(tripParticipants).values(row).returning();
    return created!;
  }

  async update(
    exec: Executor,
    id: string,
    patch: Partial<typeof tripParticipants.$inferInsert>,
  ): Promise<TripParticipantRow | null> {
    const [updated] = await exec
      .update(tripParticipants)
      .set(patch)
      .where(eq(tripParticipants.id, id))
      .returning();
    return updated ?? null;
  }

  async deactivate(exec: Executor, id: string): Promise<void> {
    await exec
      .update(tripParticipants)
      .set({ isActive: false })
      .where(eq(tripParticipants.id, id));
  }

  /**
   * Whether a participant appears anywhere in the ledger.
   * FR-SPLIT-04: someone with history can never be hard-deleted.
   */
  async hasLedgerHistory(exec: Executor, participantId: string): Promise<boolean> {
    const [row] = await exec
      .select({ total: sql<number>`
        (select count(*) from ${expenseShares}
          where ${expenseShares.participantId} = ${participantId})
        + (select count(*) from ${expensePayments}
          where ${expensePayments.participantId} = ${participantId})
        + (select count(*) from ${settlements}
          where ${settlements.fromParticipantId} = ${participantId}
             or ${settlements.toParticipantId} = ${participantId})
      `.mapWith(Number) })
      .from(sql`(select 1) as _`);

    return (row?.total ?? 0) > 0;
  }

  async countActive(exec: Executor, tripId: string): Promise<number> {
    return this.countWhere(
      exec,
      and(eq(tripParticipants.tripId, tripId), eq(tripParticipants.isActive, true)),
    );
  }

  /** Reassign every ledger reference from one participant to another (FR-SPLIT-04). */
  async reassign(exec: Executor, fromId: string, toId: string): Promise<void> {
    // Shares and payments are keyed per (expense, participant), so a naive
    // UPDATE can collide when the target already has a row on the same expense.
    // Merge those, then move the rest.
    await exec.execute(sql`
      update ${expenseShares} target
         set share_amount_minor = target.share_amount_minor + source.share_amount_minor,
             share_amount_base_minor =
               target.share_amount_base_minor + source.share_amount_base_minor
        from ${expenseShares} source
       where source.expense_id = target.expense_id
         and source.participant_id = ${fromId}
         and target.participant_id = ${toId}
    `);
    await exec.execute(sql`
      delete from ${expenseShares}
       where participant_id = ${fromId}
         and expense_id in (
           select expense_id from ${expenseShares} where participant_id = ${toId}
         )
    `);
    await exec
      .update(expenseShares)
      .set({ participantId: toId })
      .where(eq(expenseShares.participantId, fromId));

    await exec.execute(sql`
      update ${expensePayments} target
         set amount_minor = target.amount_minor + source.amount_minor,
             amount_base_minor = target.amount_base_minor + source.amount_base_minor
        from ${expensePayments} source
       where source.expense_id = target.expense_id
         and source.participant_id = ${fromId}
         and target.participant_id = ${toId}
    `);
    await exec.execute(sql`
      delete from ${expensePayments}
       where participant_id = ${fromId}
         and expense_id in (
           select expense_id from ${expensePayments} where participant_id = ${toId}
         )
    `);
    await exec
      .update(expensePayments)
      .set({ participantId: toId })
      .where(eq(expensePayments.participantId, fromId));

    await exec
      .update(settlements)
      .set({ fromParticipantId: toId })
      .where(eq(settlements.fromParticipantId, fromId));
    await exec
      .update(settlements)
      .set({ toParticipantId: toId })
      .where(eq(settlements.toParticipantId, fromId));
  }
}

export class ExpenseRepository extends BaseRepository<ExpenseRow> {
  constructor() {
    super(expenses, true);
  }

  async create(
    exec: Executor,
    expense: typeof expenses.$inferInsert,
    payments: readonly { participantId: string; amountMinor: bigint; amountBaseMinor: bigint }[],
    shares: readonly {
      participantId: string;
      shareAmountMinor: bigint;
      shareAmountBaseMinor: bigint;
      shareInput: string | null;
    }[],
    newPaymentId: () => string,
  ): Promise<ExpenseRow> {
    const [created] = await exec.insert(expenses).values(expense).returning();
    const row = created!;

    await exec.insert(expensePayments).values(
      payments.map((payment) => ({
        id: newPaymentId(),
        expenseId: row.id,
        participantId: payment.participantId,
        amountMinor: payment.amountMinor,
        amountBaseMinor: payment.amountBaseMinor,
      })),
    );

    await exec.insert(expenseShares).values(
      shares.map((share) => ({
        expenseId: row.id,
        participantId: share.participantId,
        shareAmountMinor: share.shareAmountMinor,
        shareAmountBaseMinor: share.shareAmountBaseMinor,
        shareInput: share.shareInput,
      })),
    );

    return row;
  }

  /** Replace the split of an existing expense, inside the caller's transaction. */
  async replaceSplit(
    exec: Executor,
    expenseId: string,
    payments: readonly { participantId: string; amountMinor: bigint; amountBaseMinor: bigint }[],
    shares: readonly {
      participantId: string;
      shareAmountMinor: bigint;
      shareAmountBaseMinor: bigint;
      shareInput: string | null;
    }[],
    newPaymentId: () => string,
  ): Promise<void> {
    await exec.delete(expenseShares).where(eq(expenseShares.expenseId, expenseId));
    await exec.delete(expensePayments).where(eq(expensePayments.expenseId, expenseId));

    await exec.insert(expensePayments).values(
      payments.map((payment) => ({
        id: newPaymentId(),
        expenseId,
        participantId: payment.participantId,
        amountMinor: payment.amountMinor,
        amountBaseMinor: payment.amountBaseMinor,
      })),
    );

    await exec.insert(expenseShares).values(
      shares.map((share) => ({
        expenseId,
        participantId: share.participantId,
        shareAmountMinor: share.shareAmountMinor,
        shareAmountBaseMinor: share.shareAmountBaseMinor,
        shareInput: share.shareInput,
      })),
    );
  }

  async updateFields(
    exec: Executor,
    id: string,
    expectedVersion: number,
    patch: Partial<typeof expenses.$inferInsert>,
  ): Promise<ExpenseRow> {
    return this.updateVersioned(exec, id, expectedVersion, patch);
  }

  /**
   * Lock the parent expense row.
   * §8.5: serialises two concurrent share edits rather than interleaving them.
   */
  async lockForUpdate(exec: Executor, id: string): Promise<ExpenseRow | null> {
    const rows = await exec
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, id), isNull(expenses.deletedAt)))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  async withRelations(exec: Executor, id: string): Promise<ExpenseWithRelations | null> {
    const expense = await this.findById(exec, id);
    if (!expense) return null;

    const [payments, shares] = await Promise.all([
      exec
        .select({
          participantId: expensePayments.participantId,
          amountMinor: expensePayments.amountMinor,
          amountBaseMinor: expensePayments.amountBaseMinor,
        })
        .from(expensePayments)
        .where(eq(expensePayments.expenseId, id)),
      exec
        .select({
          participantId: expenseShares.participantId,
          shareAmountMinor: expenseShares.shareAmountMinor,
          shareAmountBaseMinor: expenseShares.shareAmountBaseMinor,
        })
        .from(expenseShares)
        .where(eq(expenseShares.expenseId, id)),
    ]);

    return { expense, payments, shares };
  }

  async listByTrip(
    exec: Executor,
    tripId: string,
    filters: {
      participantId?: string;
      category?: ExpenseRow['category'];
      linked?: boolean;
      limit: number;
      cursorSpentAt?: Date;
    },
  ): Promise<ExpenseRow[]> {
    const conditions: SQL[] = [eq(expenses.tripId, tripId), isNull(expenses.deletedAt)];

    if (filters.category) conditions.push(eq(expenses.category, filters.category));
    if (filters.linked === true) conditions.push(isNotNull(expenses.blockId));
    if (filters.linked === false) conditions.push(isNull(expenses.blockId));
    if (filters.cursorSpentAt) conditions.push(lt(expenses.spentAt, filters.cursorSpentAt));

    if (filters.participantId) {
      // Scoped visibility for a Viewer (FR-NFR-SEC-10): filter in SQL, never
      // fetch everything and hide rows client-side.
      conditions.push(
        sql`exists (
          select 1 from ${expenseShares}
           where ${expenseShares.expenseId} = ${expenses.id}
             and ${expenseShares.participantId} = ${filters.participantId}
        ) or exists (
          select 1 from ${expensePayments}
           where ${expensePayments.expenseId} = ${expenses.id}
             and ${expensePayments.participantId} = ${filters.participantId}
        )`,
      );
    }

    return exec
      .select()
      .from(expenses)
      .where(and(...conditions))
      .orderBy(desc(expenses.spentAt), desc(expenses.id))
      .limit(filters.limit);
  }

  async countByTrip(exec: Executor, tripId: string): Promise<number> {
    return this.countWhere(exec, eq(expenses.tripId, tripId));
  }

  /** Bulk-load shares and payments for a page of expenses, avoiding N+1. */
  async relationsFor(
    exec: Executor,
    expenseIds: readonly string[],
  ): Promise<{
    shares: Map<string, ExpenseWithRelations['shares']>;
    payments: Map<string, ExpenseWithRelations['payments']>;
  }> {
    const shares = new Map<string, ExpenseWithRelations['shares']>();
    const payments = new Map<string, ExpenseWithRelations['payments']>();

    if (expenseIds.length === 0) return { shares, payments };

    const idList = sql.join(
      expenseIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );

    const shareRows = await exec
      .select()
      .from(expenseShares)
      .where(sql`${expenseShares.expenseId} in (${idList})`);

    for (const row of shareRows) {
      const list = shares.get(row.expenseId) ?? [];
      list.push({
        participantId: row.participantId,
        shareAmountMinor: row.shareAmountMinor,
        shareAmountBaseMinor: row.shareAmountBaseMinor,
      });
      shares.set(row.expenseId, list);
    }

    const paymentRows = await exec
      .select()
      .from(expensePayments)
      .where(sql`${expensePayments.expenseId} in (${idList})`);

    for (const row of paymentRows) {
      const list = payments.get(row.expenseId) ?? [];
      list.push({
        participantId: row.participantId,
        amountMinor: row.amountMinor,
        amountBaseMinor: row.amountBaseMinor,
      });
      payments.set(row.expenseId, list);
    }

    return { shares, payments };
  }
}

export class SettlementRepository extends BaseRepository<SettlementRow> {
  constructor() {
    super(settlements, false);
  }

  async create(
    exec: Executor,
    row: typeof settlements.$inferInsert,
  ): Promise<SettlementRow> {
    const [created] = await exec.insert(settlements).values(row).returning();
    return created!;
  }

  async listByTrip(exec: Executor, tripId: string): Promise<SettlementRow[]> {
    return exec
      .select()
      .from(settlements)
      .where(eq(settlements.tripId, tripId))
      .orderBy(desc(settlements.settledAt));
  }

  async confirm(exec: Executor, id: string): Promise<SettlementRow | null> {
    const [updated] = await exec
      .update(settlements)
      .set({ confirmedByPayee: true, confirmedAt: new Date() })
      .where(and(eq(settlements.id, id), isNull(settlements.voidedAt)))
      .returning();
    return updated ?? null;
  }

  async void(exec: Executor, id: string, reason: string): Promise<SettlementRow | null> {
    const [updated] = await exec
      .update(settlements)
      .set({ voidedAt: new Date(), voidReason: reason })
      .where(and(eq(settlements.id, id), isNull(settlements.voidedAt)))
      .returning();
    return updated ?? null;
  }
}

/**
 * Balance computation.
 *
 * §5.4 — reads the STORED base-currency columns and performs no rate
 * arithmetic. Converting per-share at read time would break `SUM(net) = 0`.
 *
 * Sign convention: paying increases your net (you are owed); your share
 * decreases it; sending a settlement increases it; receiving decreases it.
 */
export class BalanceRepository {
  async forTrip(exec: Executor, tripId: string): Promise<BalanceRow[]> {
    const rows = await exec.execute<{
      participant_id: string;
      display_name: string;
      is_placeholder: boolean;
      paid_minor: string;
      owed_minor: string;
      sent_minor: string;
      received_minor: string;
      net_minor: string;
    }>(sql`
      with paid as (
        select ep.participant_id, sum(ep.amount_base_minor) as total
          from expense_payments ep
          join expenses e on e.id = ep.expense_id
         where e.trip_id = ${tripId} and e.deleted_at is null
         group by ep.participant_id
      ),
      owed as (
        select es.participant_id, sum(es.share_amount_base_minor) as total
          from expense_shares es
          join expenses e on e.id = es.expense_id
         where e.trip_id = ${tripId} and e.deleted_at is null
         group by es.participant_id
      ),
      sent as (
        select from_participant_id as participant_id, sum(amount_minor) as total
          from settlements
         where trip_id = ${tripId} and voided_at is null
         group by from_participant_id
      ),
      received as (
        select to_participant_id as participant_id, sum(amount_minor) as total
          from settlements
         where trip_id = ${tripId} and voided_at is null
         group by to_participant_id
      )
      select p.id                                  as participant_id,
             p.display_name                        as display_name,
             (p.user_id is null)                   as is_placeholder,
             coalesce(paid.total, 0)::text         as paid_minor,
             coalesce(owed.total, 0)::text         as owed_minor,
             coalesce(sent.total, 0)::text         as sent_minor,
             coalesce(received.total, 0)::text     as received_minor,
             ( coalesce(paid.total, 0) - coalesce(owed.total, 0)
             + coalesce(sent.total, 0) - coalesce(received.total, 0) )::text as net_minor
        from trip_participants p
        left join paid     on paid.participant_id     = p.id
        left join owed     on owed.participant_id     = p.id
        left join sent     on sent.participant_id     = p.id
        left join received on received.participant_id = p.id
       where p.trip_id = ${tripId}
       order by p.created_at
    `);

    return (rows.rows ?? []).map((row) => ({
      participantId: row.participant_id,
      displayName: row.display_name,
      isPlaceholder: row.is_placeholder,
      paidMinor: BigInt(row.paid_minor),
      owedMinor: BigInt(row.owed_minor),
      sentMinor: BigInt(row.sent_minor),
      receivedMinor: BigInt(row.received_minor),
      netMinor: BigInt(row.net_minor),
    }));
  }

  /** Total group spend in base currency. */
  async totalSpent(exec: Executor, tripId: string): Promise<bigint> {
    const result = await exec.execute<{ total: string }>(sql`
      select coalesce(sum(amount_base_minor), 0)::text as total
        from expenses
       where trip_id = ${tripId} and deleted_at is null
    `);
    return BigInt(result.rows?.[0]?.total ?? '0');
  }

  /** Per-category totals for the summary panel (FR-SPLIT-35). */
  async byCategory(
    exec: Executor,
    tripId: string,
  ): Promise<{ category: string; totalMinor: bigint; count: number }[]> {
    const result = await exec.execute<{ category: string; total: string; count: number }>(sql`
      select category, coalesce(sum(amount_base_minor), 0)::text as total, count(*)::int as count
        from expenses
       where trip_id = ${tripId} and deleted_at is null
       group by category
       order by sum(amount_base_minor) desc
    `);

    return (result.rows ?? []).map((row) => ({
      category: row.category,
      totalMinor: BigInt(row.total),
      count: Number(row.count),
    }));
  }

  /** Cross-trip summary for the dashboard hook (FR-SPLIT-38). */
  async forUser(
    exec: Executor,
    userId: string,
  ): Promise<{ tripId: string; tripTitle: string; baseCurrency: string; netMinor: bigint }[]> {
    const result = await exec.execute<{
      trip_id: string;
      trip_title: string;
      base_currency: string;
      net_minor: string;
    }>(sql`
      with mine as (
        select p.id as participant_id, p.trip_id
          from trip_participants p
         where p.user_id = ${userId} and p.is_active = true
      )
      select t.id as trip_id,
             t.title as trip_title,
             t.base_currency as base_currency,
             (
               coalesce((select sum(ep.amount_base_minor) from expense_payments ep
                          join expenses e on e.id = ep.expense_id
                         where ep.participant_id = mine.participant_id
                           and e.deleted_at is null), 0)
             - coalesce((select sum(es.share_amount_base_minor) from expense_shares es
                          join expenses e on e.id = es.expense_id
                         where es.participant_id = mine.participant_id
                           and e.deleted_at is null), 0)
             + coalesce((select sum(s.amount_minor) from settlements s
                         where s.from_participant_id = mine.participant_id
                           and s.voided_at is null), 0)
             - coalesce((select sum(s.amount_minor) from settlements s
                         where s.to_participant_id = mine.participant_id
                           and s.voided_at is null), 0)
             )::text as net_minor
        from mine
        join trips t on t.id = mine.trip_id
       where t.deleted_at is null
    `);

    return (result.rows ?? [])
      .map((row) => ({
        tripId: row.trip_id,
        tripTitle: row.trip_title,
        baseCurrency: row.base_currency,
        netMinor: BigInt(row.net_minor),
      }))
      .filter((row) => row.netMinor !== 0n);
  }
}
