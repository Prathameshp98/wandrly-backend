/**
 * Ledger orchestration.
 *
 * TECHNICAL_DESIGN §7.18. Dependencies are constructor-injected so every method
 * is testable against fakes and the composition root stays in one file.
 *
 * The service is responsible for the rules the database cannot express:
 * limits, FX freezing, participant validity, settle-up, and the audit trail.
 * The rules the database CAN express — shares summing to the total — are
 * enforced by deferred triggers, belt and braces.
 */

import { eq, sql } from 'drizzle-orm';

import { limits } from '../../platform/config/env';
import { newId } from '../../platform/crypto/index';
import { withTransaction, type Executor, db } from '../../platform/db/index';
import { trips } from '../../platform/db/schema/index';
import {
  DomainRuleError,
  LedgerImbalanceError,
  LimitExceededError,
  NotFoundError,
  ParticipantHasHistoryError,
} from '../../platform/errors/AppError';
import { FxService } from '../../platform/fx/fx.service';
import { DeferredBroadcast } from '../../platform/realtime/hub';
import {
  convertMinor,
  formatMinor,
  isFullySettled,
  nettedPairwise,
  parseRate,
  simplify,
} from '../../money/index';
import { ledgerScope, type TripAccess } from '../../platform/policy/index';
import { decryptField, encryptField } from '../../platform/crypto/index';
import type {
  AddParticipantBody,
  CreateExpenseBody,
  RecordSettlementBody,
  UpdateParticipantBody,
} from '../../contracts/ledger';
import { activityService, type ActivityService } from '../notifications/activity.service';
import {
  BalanceRepository,
  ExpenseRepository,
  ParticipantRepository,
  SettlementRepository,
  type BalanceRow,
} from './ledger.repository';
import { resolvePayments, resolveSplit } from './split.resolver';

export interface LedgerServiceDeps {
  readonly participants: ParticipantRepository;
  readonly expenses: ExpenseRepository;
  readonly settlements: SettlementRepository;
  readonly balances: BalanceRepository;
  readonly fx: FxService;
  readonly activity: ActivityService;
}

export interface Transfer {
  fromParticipantId: string;
  fromName: string;
  toParticipantId: string;
  toName: string;
  amountMinor: bigint;
  payeeUpiId: string | null;
  upiDeepLink: string | null;
}

export class LedgerService {
  constructor(private readonly deps: LedgerServiceDeps) {}

  // ── Participants ──────────────────────────────────────────────────

  async listParticipants(access: TripAccess) {
    const rows = await this.deps.participants.listByTrip(db, access.tripId);
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      displayName: row.displayName,
      avatarTone: row.avatarTone,
      isPlaceholder: row.userId === null,
      isActive: row.isActive,
      claimedAt: row.claimedAt?.toISOString() ?? null,
      hasPayoutDetails: Boolean(row.payoutUpiId || row.payoutBankRef),
    }));
  }

  /** FR-SPLIT-01 — placeholder participants need no account. */
  async addParticipant(access: TripAccess, input: AddParticipantBody) {
    return withTransaction(async (tx) => {
      const count = await this.deps.participants.countActive(tx, access.tripId);
      if (count >= limits.participantsPerTrip) {
        throw new LimitExceededError('people on a trip', limits.participantsPerTrip);
      }

      const participant = await this.deps.participants.create(tx, {
        id: newId(),
        tripId: access.tripId,
        userId: null,
        displayName: input.displayName,
        avatarTone: input.avatarTone,
        claimInviteEmail: input.claimInviteEmail ?? null,
        createdBy: access.userId,
      });

      await this.deps.activity.record(tx, {
        tripId: access.tripId,
        actorId: access.userId,
        kind: 'participant.created',
        entityType: 'trip_participant',
        entityId: participant.id,
        after: { displayName: participant.displayName, isPlaceholder: true },
      });

      return participant;
    });
  }

  async updateParticipant(
    access: TripAccess,
    participantId: string,
    input: UpdateParticipantBody,
  ) {
    const existing = await this.deps.participants.findById(db, participantId);
    if (!existing || existing.tripId !== access.tripId) {
      throw new NotFoundError('Participant');
    }

    // Payout identifiers are sensitive: encrypted at rest (FR-NFR-SEC-11).
    const patch: Record<string, unknown> = {};
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.avatarTone !== undefined) patch.avatarTone = input.avatarTone;
    if (input.payoutUpiId !== undefined) {
      patch.payoutUpiId = input.payoutUpiId ? encryptField(input.payoutUpiId) : null;
    }
    if (input.payoutBankRef !== undefined) {
      patch.payoutBankRef = input.payoutBankRef ? encryptField(input.payoutBankRef) : null;
    }

    const updated = await this.deps.participants.update(db, participantId, patch);
    if (!updated) throw new NotFoundError('Participant');
    return updated;
  }

  /**
   * FR-SPLIT-04 — a participant with ledger history is never hard-deleted.
   * Removal requires either a zero net balance or explicit reassignment.
   */
  async removeParticipant(
    access: TripAccess,
    participantId: string,
    reassignToParticipantId?: string,
  ): Promise<void> {
    await withTransaction(async (tx) => {
      const participant = await this.deps.participants.findById(tx, participantId);
      if (!participant || participant.tripId !== access.tripId) {
        throw new NotFoundError('Participant');
      }

      const hasHistory = await this.deps.participants.hasLedgerHistory(tx, participantId);

      if (hasHistory) {
        if (reassignToParticipantId) {
          const target = await this.deps.participants.findById(tx, reassignToParticipantId);
          if (!target || target.tripId !== access.tripId) {
            throw new NotFoundError('Reassignment target');
          }
          if (target.id === participantId) {
            throw new DomainRuleError('Cannot reassign a participant to themselves');
          }
          await this.deps.participants.reassign(tx, participantId, reassignToParticipantId);
        } else {
          const balances = await this.deps.balances.forTrip(tx, access.tripId);
          const net = balances.find((b) => b.participantId === participantId)?.netMinor ?? 0n;
          if (net !== 0n) {
            throw new ParticipantHasHistoryError({
              participantId,
              netMinor: net.toString(),
            });
          }
        }
      }

      await this.deps.participants.deactivate(tx, participantId);

      await this.deps.activity.record(tx, {
        tripId: access.tripId,
        actorId: access.userId,
        kind: 'participant.removed',
        entityType: 'trip_participant',
        entityId: participantId,
        before: { displayName: participant.displayName },
        after: { reassignedTo: reassignToParticipantId ?? null },
      });
    });
  }

  // ── Expenses ──────────────────────────────────────────────────────

  async createExpense(access: TripAccess, input: CreateExpenseBody) {
    const broadcast = new DeferredBroadcast();

    const created = await withTransaction(async (tx) => {
      const count = await this.deps.expenses.countByTrip(tx, access.tripId);
      if (count >= limits.expensesPerTrip) {
        throw new LimitExceededError('expenses on a trip', limits.expensesPerTrip);
      }

      const participantIds = await this.activeParticipantIds(tx, access.tripId);

      const amountMinor = BigInt(input.amountMinor);
      const { rate, source } = await this.deps.fx.resolve(
        input.currency,
        access.baseCurrency,
        input.fxRateOverride,
        tx,
      );

      // Frozen at creation. Never recomputed on read (FR-SPLIT-19).
      const amountBaseMinor = convertMinor(
        amountMinor,
        parseRate(rate),
        input.currency,
        access.baseCurrency,
      );

      const payments = resolvePayments(
        input.payments,
        amountMinor,
        amountBaseMinor,
        input.currency,
        participantIds,
      );

      const shares = resolveSplit({
        split: input.split,
        totalMinor: amountMinor,
        totalBaseMinor: amountBaseMinor,
        currency: input.currency,
        validParticipantIds: participantIds,
      });

      const expense = await this.deps.expenses.create(
        tx,
        {
          id: newId(),
          tripId: access.tripId,
          description: input.description,
          amountMinor,
          currency: input.currency,
          fxRateToBase: rate,
          fxRateSource: source,
          amountBaseMinor,
          spentAt: input.spentAt ? new Date(input.spentAt) : new Date(),
          category: (input.category ?? 'OTHER') as never,
          splitMethod: input.split.method as never,
          blockId: input.blockId ?? null,
          dayId: input.dayId ?? null,
          receiptAssetIds: input.receiptAssetIds,
          note: input.note ?? null,
          createdBy: access.userId,
        },
        payments,
        shares,
        newId,
      );

      await this.deps.activity.record(tx, {
        tripId: access.tripId,
        actorId: access.userId,
        kind: 'expense.created',
        entityType: 'expense',
        entityId: expense.id,
        after: {
          description: expense.description,
          amountMinor: amountMinor.toString(),
          currency: expense.currency,
          splitMethod: expense.splitMethod,
          participantCount: shares.length,
        },
      });

      // FR-SPLIT-39 — everyone included in the split is told.
      await this.deps.activity.notify(tx, {
        tripId: access.tripId,
        actorId: access.userId,
        kind: 'EXPENSE',
        entityType: 'expense',
        entityId: expense.id,
        body: `added an expense: ${expense.description}`,
        userIds: await this.userIdsForParticipants(
          tx,
          shares.map((s) => s.participantId),
        ),
      });

      broadcast.queue({
        kind: 'expense.created',
        tripId: access.tripId,
        entityId: expense.id,
        actorId: access.userId,
      });

      return expense;
    });

    // Only after commit (§7).
    broadcast.flush();
    return created;
  }

  async deleteExpense(access: TripAccess, expenseId: string): Promise<void> {
    const broadcast = new DeferredBroadcast();

    await withTransaction(async (tx) => {
      const expense = await this.deps.expenses.findById(tx, expenseId);
      if (!expense || expense.tripId !== access.tripId) throw new NotFoundError('Expense');

      await this.deps.expenses.softDelete(tx, expenseId);

      await this.deps.activity.record(tx, {
        tripId: access.tripId,
        actorId: access.userId,
        kind: 'expense.deleted',
        entityType: 'expense',
        entityId: expenseId,
        before: {
          description: expense.description,
          amountMinor: expense.amountMinor.toString(),
          currency: expense.currency,
        },
      });

      broadcast.queue({
        kind: 'expense.deleted',
        tripId: access.tripId,
        entityId: expenseId,
        actorId: access.userId,
      });
    });

    broadcast.flush();
  }

  /** Undo support for the 10-second toast (FR-SPLIT-42). */
  async restoreExpense(access: TripAccess, expenseId: string): Promise<void> {
    await withTransaction(async (tx) => {
      const restored = await this.deps.expenses.restore(tx, expenseId);
      if (!restored) throw new NotFoundError('Expense');

      await this.deps.activity.record(tx, {
        tripId: access.tripId,
        actorId: access.userId,
        kind: 'expense.restored',
        entityType: 'expense',
        entityId: expenseId,
      });
    });
  }

  async listExpenses(
    access: TripAccess,
    filters: {
      participantId?: string;
      category?: string;
      linked?: boolean;
      limit: number;
      cursor?: string;
    },
  ) {
    const scope = ledgerScope(access);
    if (scope === 'NONE') return { items: [], nextCursor: null };

    // A Viewer sees only expenses they are part of — enforced in SQL.
    const participantId =
      scope === 'OWN' ? (access.participantId ?? undefined) : filters.participantId;

    const rows = await this.deps.expenses.listByTrip(db, access.tripId, {
      participantId,
      category: filters.category as never,
      linked: filters.linked,
      limit: filters.limit + 1,
      cursorSpentAt: filters.cursor ? new Date(filters.cursor) : undefined,
    });

    const hasMore = rows.length > filters.limit;
    const page = hasMore ? rows.slice(0, filters.limit) : rows;

    const { shares, payments } = await this.deps.expenses.relationsFor(
      db,
      page.map((row) => row.id),
    );

    const participants = await this.deps.participants.listByTrip(db, access.tripId, true);
    const names = new Map(participants.map((p) => [p.id, p.displayName]));

    return {
      items: page.map((expense) => {
        const expenseShares = shares.get(expense.id) ?? [];
        const own = access.participantId
          ? expenseShares.find((s) => s.participantId === access.participantId)
          : undefined;

        return {
          expense,
          baseCurrency: access.baseCurrency,
          payments: (payments.get(expense.id) ?? []).map((p) => ({
            ...p,
            participantName: names.get(p.participantId) ?? 'Unknown',
          })),
          shares: expenseShares.map((s) => ({
            ...s,
            participantName: names.get(s.participantId) ?? 'Unknown',
          })),
          yourShareMinor: own?.shareAmountMinor ?? null,
        };
      }),
      nextCursor: hasMore ? (page.at(-1)?.spentAt.toISOString() ?? null) : null,
    };
  }

  // ── Balances and settle-up ────────────────────────────────────────

  async balances(access: TripAccess) {
    const rows = await this.deps.balances.forTrip(db, access.tripId);
    const totalSpentMinor = await this.deps.balances.totalSpent(db, access.tripId);

    this.assertBalanced(rows);

    return {
      baseCurrency: access.baseCurrency,
      totalSpentMinor,
      isFullySettled: isFullySettled(new Map(rows.map((r) => [r.participantId, r.netMinor]))),
      balances: rows,
    };
  }

  /**
   * FR-SPLIT-25/26/27 — the suggested transfer set, with a UPI hand-off.
   * Wandrly computes and hands off; it never moves money.
   */
  async settleUp(
    access: TripAccess,
    overrideSimplify?: boolean,
  ): Promise<{ simplified: boolean; transfers: Transfer[] }> {
    const rows = await this.deps.balances.forTrip(db, access.tripId);
    this.assertBalanced(rows);

    const participants = await this.deps.participants.listByTrip(db, access.tripId, true);
    const byId = new Map(participants.map((p) => [p.id, p]));

    const simplified = overrideSimplify ?? (await this.tripSimplifyPreference(access.tripId));

    const balanceMap = new Map(rows.map((r) => [r.participantId, r.netMinor]));

    const raw = simplified
      ? simplify(balanceMap)
      : nettedPairwise(await this.pairwiseDebts(access.tripId));

    const transfers: Transfer[] = raw.map((transfer) => {
      const payee = byId.get(transfer.to);
      const upiId = payee?.payoutUpiId ? decryptField(payee.payoutUpiId) : null;

      return {
        fromParticipantId: transfer.from,
        fromName: byId.get(transfer.from)?.displayName ?? 'Unknown',
        toParticipantId: transfer.to,
        toName: payee?.displayName ?? 'Unknown',
        amountMinor: transfer.amount,
        payeeUpiId: upiId,
        upiDeepLink: upiId
          ? this.buildUpiLink(upiId, payee?.displayName ?? '', transfer.amount, access.baseCurrency)
          : null,
      };
    });

    return { simplified, transfers };
  }

  async recordSettlement(access: TripAccess, input: RecordSettlementBody) {
    const broadcast = new DeferredBroadcast();

    const settlement = await withTransaction(async (tx) => {
      const [from, to] = await Promise.all([
        this.deps.participants.findById(tx, input.fromParticipantId),
        this.deps.participants.findById(tx, input.toParticipantId),
      ]);

      if (!from || from.tripId !== access.tripId) throw new NotFoundError('Payer');
      if (!to || to.tripId !== access.tripId) throw new NotFoundError('Payee');

      // A non-Owner may only record transfers they are party to (PRD §8).
      const isParty =
        access.participantId === from.id || access.participantId === to.id;
      if (access.role !== 'OWNER' && !isParty) {
        throw new DomainRuleError('You can only record settlements you are part of');
      }

      const recordedBy = access.participantId ?? from.id;

      const created = await this.deps.settlements.create(tx, {
        id: newId(),
        tripId: access.tripId,
        fromParticipantId: from.id,
        toParticipantId: to.id,
        amountMinor: BigInt(input.amountMinor),
        currency: access.baseCurrency,
        method: input.method as never,
        note: input.note ?? null,
        settledAt: input.settledAt ? new Date(input.settledAt) : new Date(),
        recordedBy,
      });

      await this.deps.activity.record(tx, {
        tripId: access.tripId,
        actorId: access.userId,
        kind: 'settlement.created',
        entityType: 'settlement',
        entityId: created.id,
        after: {
          from: from.displayName,
          to: to.displayName,
          amountMinor: input.amountMinor,
          method: input.method,
        },
      });

      if (to.userId) {
        await this.deps.activity.notify(tx, {
          tripId: access.tripId,
          actorId: access.userId,
          kind: 'SETTLEMENT',
          entityType: 'settlement',
          entityId: created.id,
          body: `recorded a payment of ${input.amountMinor} to you`,
          userIds: [to.userId],
        });
      }

      broadcast.queue({
        kind: 'settlement.created',
        tripId: access.tripId,
        entityId: created.id,
        actorId: access.userId,
      });

      return created;
    });

    broadcast.flush();
    return settlement;
  }

  async confirmSettlement(access: TripAccess, settlementId: string) {
    return withTransaction(async (tx) => {
      const existing = await this.deps.settlements.findById(tx, settlementId);
      if (!existing || existing.tripId !== access.tripId) {
        throw new NotFoundError('Settlement');
      }

      // Only the payee confirms receipt (FR-SPLIT-29).
      if (access.role !== 'OWNER' && access.participantId !== existing.toParticipantId) {
        throw new DomainRuleError('Only the person who received the payment can confirm it');
      }

      const confirmed = await this.deps.settlements.confirm(tx, settlementId);
      if (!confirmed) throw new DomainRuleError('This settlement has been voided');

      await this.deps.activity.record(tx, {
        tripId: access.tripId,
        actorId: access.userId,
        kind: 'settlement.confirmed',
        entityType: 'settlement',
        entityId: settlementId,
      });

      return confirmed;
    });
  }

  async voidSettlement(access: TripAccess, settlementId: string, reason: string) {
    return withTransaction(async (tx) => {
      const existing = await this.deps.settlements.findById(tx, settlementId);
      if (!existing || existing.tripId !== access.tripId) {
        throw new NotFoundError('Settlement');
      }

      const voided = await this.deps.settlements.void(tx, settlementId, reason);
      if (!voided) throw new DomainRuleError('This settlement is already voided');

      await this.deps.activity.record(tx, {
        tripId: access.tripId,
        actorId: access.userId,
        kind: 'settlement.voided',
        entityType: 'settlement',
        entityId: settlementId,
        after: { reason },
      });

      return voided;
    });
  }

  async listSettlements(access: TripAccess) {
    const [rows, participants] = await Promise.all([
      this.deps.settlements.listByTrip(db, access.tripId),
      this.deps.participants.listByTrip(db, access.tripId, true),
    ]);

    const names = new Map(participants.map((p) => [p.id, p.displayName]));

    return rows.map((row) => ({
      ...row,
      fromName: names.get(row.fromParticipantId) ?? 'Unknown',
      toName: names.get(row.toParticipantId) ?? 'Unknown',
    }));
  }

  /** Cross-trip balance summary for the dashboard hook (FR-SPLIT-38). */
  async balancesForUser(userId: string) {
    return this.deps.balances.forUser(db, userId);
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async activeParticipantIds(
    exec: Executor,
    tripId: string,
  ): Promise<Set<string>> {
    const rows = await this.deps.participants.listByTrip(exec, tripId);
    return new Set(rows.map((row) => row.id));
  }

  private async userIdsForParticipants(
    exec: Executor,
    participantIds: readonly string[],
  ): Promise<string[]> {
    const participants = await Promise.all(
      participantIds.map((id) => this.deps.participants.findById(exec, id)),
    );
    return participants
      .map((participant) => participant?.userId)
      .filter((userId): userId is string => Boolean(userId));
  }

  /**
   * FR-SPLIT-18 — a corrupt ledger must fail loudly rather than produce
   * confident, wrong settle-up advice.
   *
   * This is the application-layer half of the triple guard: the database has
   * deferred triggers, the money layer throws in `simplify()`, and a nightly
   * job reconciles. Redundant on purpose.
   */
  private assertBalanced(rows: readonly BalanceRow[]): void {
    const residual = rows.reduce((sum, row) => sum + row.netMinor, 0n);
    if (residual !== 0n) {
      throw new LedgerImbalanceError(residual);
    }
  }

  private async tripSimplifyPreference(tripId: string): Promise<boolean> {
    const rows = await db
      .select({ simplifyDebts: trips.simplifyDebts })
      .from(trips)
      .where(eq(trips.id, tripId))
      .limit(1);
    return rows[0]?.simplifyDebts ?? true;
  }

  /** Raw pairwise obligations, for when simplification is off (FR-SPLIT-26). */
  private async pairwiseDebts(
    tripId: string,
  ): Promise<{ from: string; to: string; amount: bigint }[]> {
    const result = await db.execute<{ from_id: string; to_id: string; amount: string }>(sql`
      select es.participant_id as from_id,
             ep.participant_id as to_id,
             sum(
               es.share_amount_base_minor
               * ep.amount_base_minor
               / nullif(e.amount_base_minor, 0)
             )::bigint::text as amount
        from expenses e
        join expense_shares es   on es.expense_id = e.id
        join expense_payments ep on ep.expense_id = e.id
       where e.trip_id = ${tripId}
         and e.deleted_at is null
         and es.participant_id <> ep.participant_id
       group by es.participant_id, ep.participant_id
    `);

    return (result.rows ?? []).map((row) => ({
      from: row.from_id,
      to: row.to_id,
      amount: BigInt(row.amount ?? '0'),
    }));
  }

  private buildUpiLink(
    upiId: string,
    payeeName: string,
    amountMinor: bigint,
    currency: string,
  ): string {
    // A URI scheme and nothing more — no PSP, no integration, no licensing.
    const params = new URLSearchParams({
      pa: upiId,
      pn: payeeName,
      am: formatMinor(amountMinor, currency),
      cu: currency,
      tn: 'Wandrly trip settlement',
    });
    return `upi://pay?${params.toString()}`;
  }
}

/** Composition root for the ledger module. */
export const ledgerService = new LedgerService({
  participants: new ParticipantRepository(),
  expenses: new ExpenseRepository(),
  settlements: new SettlementRepository(),
  balances: new BalanceRepository(),
  fx: new FxService(),
  activity: activityService,
});
