/**
 * Ledger routes.
 *
 * TECHNICAL_DESIGN §8.1 — handlers are three lines: delegate, serialise,
 * respond. No business logic, no direct DB access, no conditionals.
 *
 * `withTripAccess` is the only way these run: it loads the access object once
 * and asserts the policy, and the service signature requires the result.
 */

import { Router } from 'express';

import {
  AddParticipantBody,
  CreateExpenseBody,
  ListExpensesQuery,
  RecordSettlementBody,
  RemoveParticipantQuery,
  UpdateParticipantBody,
  VoidSettlementBody,
} from '../../contracts/ledger';
import { IdParam, SettleUpQuery, TripAndIdParam, TripIdParam } from '../../contracts/index';
import { validate, validated } from '../../platform/http/validate';
import { idempotent } from '../../platform/http/idempotency';
import { accessOf, withTripAccess, withTripRead } from '../../platform/http/withTripAccess';
import { ledgerService } from './ledger.service';
import {
  toBalancesResponse,
  toExpenseDTO,
  toParticipantDTO,
  toSettleUpResponse,
  toSettlementDTO,
} from './ledger.presenter';

export const ledgerRouter = Router();

// ── Participants ────────────────────────────────────────────────────

ledgerRouter.get(
  '/trips/:tripId/participants',
  validate({ params: TripIdParam }),
  withTripRead('trip:view'),
  async (req, res) => {
    const participants = await ledgerService.listParticipants(accessOf(req));
    res.json({ items: participants });
  },
);

ledgerRouter.post(
  '/trips/:tripId/participants',
  validate({ params: TripIdParam, body: AddParticipantBody }),
  withTripAccess('participant:manage'),
  async (req, res) => {
    const participant = await ledgerService.addParticipant(
      accessOf(req),
      validated.body(req, AddParticipantBody),
    );
    res.status(201).json(toParticipantDTO(participant));
  },
);

ledgerRouter.patch(
  '/trips/:tripId/participants/:id',
  validate({ params: TripAndIdParam, body: UpdateParticipantBody }),
  withTripAccess('participant:manage'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    const participant = await ledgerService.updateParticipant(
      accessOf(req),
      id,
      validated.body(req, UpdateParticipantBody),
    );
    res.json(toParticipantDTO(participant));
  },
);

ledgerRouter.delete(
  '/trips/:tripId/participants/:id',
  validate({ params: TripAndIdParam, query: RemoveParticipantQuery }),
  withTripAccess('participant:manage'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    const { reassignToParticipantId } = validated.query(req, RemoveParticipantQuery);
    await ledgerService.removeParticipant(accessOf(req), id, reassignToParticipantId);
    res.status(204).end();
  },
);

// ── Expenses ────────────────────────────────────────────────────────

ledgerRouter.get(
  '/trips/:tripId/expenses',
  validate({ params: TripIdParam, query: ListExpensesQuery }),
  withTripRead('trip:view'),
  async (req, res) => {
    const query = validated.query(req, ListExpensesQuery);
    const page = await ledgerService.listExpenses(accessOf(req), {
      participantId: query.participantId,
      category: query.category,
      linked: query.linked === undefined ? undefined : query.linked === 'true',
      limit: query.limit,
      cursor: query.cursor,
    });

    res.json({
      items: page.items.map(toExpenseDTO),
      nextCursor: page.nextCursor,
    });
  },
);

ledgerRouter.post(
  '/trips/:tripId/expenses',
  validate({ params: TripIdParam, body: CreateExpenseBody }),
  withTripAccess('expense:create'),
  // A double-tap on a flaky connection must not create two ₹5,000 expenses.
  idempotent(),
  async (req, res) => {
    const expense = await ledgerService.createExpense(
      accessOf(req),
      validated.body(req, CreateExpenseBody),
    );
    res.status(201).json({ id: expense.id });
  },
);

ledgerRouter.delete(
  '/trips/:tripId/expenses/:id',
  validate({ params: TripAndIdParam }),
  // 'expense:create' is the coarse gate — it admits exactly the roles PRD §8
  // lets touch an expense at all. Gating on 'expense:edit-any' here refused a
  // Contributor their own expense, because the middleware has no resource to
  // resolve '-any' down to '-own' against. The service does that check.
  withTripAccess('expense:create'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    await ledgerService.deleteExpense(accessOf(req), id);
    res.status(204).end();
  },
);

ledgerRouter.post(
  '/trips/:tripId/expenses/:id/restore',
  validate({ params: TripAndIdParam }),
  withTripAccess('expense:create'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    await ledgerService.restoreExpense(accessOf(req), id);
    res.status(204).end();
  },
);

// ── Balances and settlement ─────────────────────────────────────────

ledgerRouter.get(
  '/trips/:tripId/balances',
  validate({ params: TripIdParam }),
  withTripRead('trip:view'),
  async (req, res) => {
    const balances = await ledgerService.balances(accessOf(req));
    res.json(toBalancesResponse(balances));
  },
);

ledgerRouter.get(
  '/trips/:tripId/settle-up',
  validate({ params: TripIdParam, query: SettleUpQuery }),
  withTripRead('trip:view'),
  async (req, res) => {
    const { simplify } = validated.query(req, SettleUpQuery);
    const access = accessOf(req);
    const result = await ledgerService.settleUp(
      access,
      simplify === undefined ? undefined : simplify === 'true',
    );
    res.json(toSettleUpResponse(access.baseCurrency, result));
  },
);

ledgerRouter.get(
  '/trips/:tripId/settlements',
  validate({ params: TripIdParam }),
  withTripRead('trip:view'),
  async (req, res) => {
    const settlements = await ledgerService.listSettlements(accessOf(req));
    res.json({ items: settlements.map(toSettlementDTO) });
  },
);

ledgerRouter.post(
  '/trips/:tripId/settlements',
  validate({ params: TripIdParam, body: RecordSettlementBody }),
  withTripAccess('settlement:record-own'),
  idempotent(),
  async (req, res) => {
    const settlement = await ledgerService.recordSettlement(
      accessOf(req),
      validated.body(req, RecordSettlementBody),
    );
    res.status(201).json({ id: settlement.id });
  },
);

ledgerRouter.post(
  '/trips/:tripId/settlements/:id/confirm',
  validate({ params: TripAndIdParam }),
  withTripAccess('settlement:confirm-own'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    const settlement = await ledgerService.confirmSettlement(accessOf(req), id);
    res.json({ id: settlement.id, confirmedAt: settlement.confirmedAt });
  },
);

ledgerRouter.post(
  '/trips/:tripId/settlements/:id/void',
  validate({ params: TripAndIdParam, body: VoidSettlementBody }),
  withTripAccess('settlement:void'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    const { reason } = validated.body(req, VoidSettlementBody);
    const settlement = await ledgerService.voidSettlement(accessOf(req), id, reason);
    res.json({ id: settlement.id, voidedAt: settlement.voidedAt });
  },
);

// ── Cross-trip summary (FR-SPLIT-38) ────────────────────────────────

export const meLedgerRouter = Router();

meLedgerRouter.get('/me/balances', validate({}), async (req, res) => {
  const balances = await ledgerService.balancesForUser(req.ctx.userId);
  res.json({
    items: balances.map((row) => ({
      tripId: row.tripId,
      tripTitle: row.tripTitle,
      baseCurrency: row.baseCurrency,
      netMinor: row.netMinor.toString(),
    })),
  });
});

void IdParam;
