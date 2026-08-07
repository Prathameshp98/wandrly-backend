/**
 * Audit log and notification fan-out.
 *
 * TECHNICAL_DESIGN §5.6, §10.3.
 *
 * Two rules that make the audit trail trustworthy:
 *   1. Ledger mutations write their audit row INSIDE the same transaction as the
 *      mutation. If the audit write fails, the mutation rolls back.
 *   2. The application role holds no UPDATE or DELETE grant on activity_events.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Executor } from '../../platform/db/index';
import {
  activityEvents,
  notifications,
  tripMembers,
  users,
  type NewActivityEventRow,
} from '../../platform/db/schema/index';
import { newId } from '../../platform/crypto/index';

/** Kinds that email immediately vs. batch on a 30-minute sweep (§10.3). */
const IMMEDIATE_EMAIL_KINDS = new Set(['INVITE', 'MENTION']);

export type NotificationKind =
  | 'COMMENT'
  | 'BLOCK'
  | 'INVITE'
  | 'EDIT'
  | 'MENTION'
  | 'EXPENSE'
  | 'SETTLEMENT'
  | 'SETTLEMENT_CONFIRMED'
  | 'SETTLEMENT_NUDGE';

export interface RecordActivityArgs {
  readonly tripId: string;
  readonly actorId: string | null;
  readonly kind: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface NotifyArgs {
  readonly tripId: string;
  readonly actorId: string | null;
  readonly kind: NotificationKind;
  readonly body: string;
  readonly entityType?: string;
  readonly entityId?: string | null;
  /** Explicit recipients. When omitted, every other trip member is notified. */
  readonly userIds?: readonly string[];
}

export class ActivityService {
  /**
   * Append an audit event.
   *
   * `before`/`after` capture the change so FR-SPLIT-41 ("silent edits to shared
   * financial records are prohibited") holds, and so a future version-history
   * feature (FR-UNDO-04) has the data without a schema change.
   */
  async record(exec: Executor, args: RecordActivityArgs): Promise<void> {
    const row: NewActivityEventRow = {
      tripId: args.tripId,
      actorId: args.actorId,
      kind: args.kind,
      entityType: args.entityType,
      entityId: args.entityId ?? null,
      before: args.before === undefined ? null : (args.before as never),
      after: args.after === undefined ? null : (args.after as never),
    };

    await exec.insert(activityEvents).values(row);
  }

  /**
   * Create in-app notifications, and stage emails per the §10.3 rules.
   *
   * Self-actions are filtered at creation, not at render — otherwise the unread
   * badge counts your own edits.
   */
  async notify(exec: Executor, args: NotifyArgs): Promise<number> {
    const recipients = args.userIds
      ? [...new Set(args.userIds)]
      : await this.tripMemberIds(exec, args.tripId);

    const targets = recipients.filter((userId) => userId !== args.actorId);
    if (targets.length === 0) return 0;

    // Respect the per-user email preference at creation time.
    const preferences = await exec
      .select({ id: users.id, emailEnabled: users.emailNotificationsEnabled })
      .from(users)
      .where(inArray(users.id, targets));

    const emailEnabled = new Map(preferences.map((row) => [row.id, row.emailEnabled]));

    await exec.insert(notifications).values(
      targets.map((userId) => ({
        id: newId(),
        userId,
        tripId: args.tripId,
        kind: args.kind as never,
        actorId: args.actorId,
        entityType: args.entityType ?? null,
        entityId: args.entityId ?? null,
        body: args.body,
        emailState: (emailEnabled.get(userId) === false
          ? 'SUPPRESSED'
          : IMMEDIATE_EMAIL_KINDS.has(args.kind)
            ? 'PENDING'
            : 'BATCHED') as never,
      })),
    );

    return targets.length;
  }

  private async tripMemberIds(exec: Executor, tripId: string): Promise<string[]> {
    const rows = await exec
      .select({ userId: tripMembers.userId })
      .from(tripMembers)
      .where(eq(tripMembers.tripId, tripId));
    return rows.map((row) => row.userId);
  }

  /** Activity feed (FR-NOTIF-04). */
  async listForTrip(
    exec: Executor,
    tripId: string,
    limit = 50,
  ): Promise<(typeof activityEvents.$inferSelect)[]> {
    return exec
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.tripId, tripId))
      .orderBy(sql`${activityEvents.createdAt} desc`)
      .limit(limit);
  }

  /** Unread badge count (FR-NOTIF-08). */
  async unreadCount(exec: Executor, userId: string): Promise<number> {
    const [row] = await exec
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));
    return row?.count ?? 0;
  }

  async markAllRead(exec: Executor, userId: string): Promise<void> {
    await exec
      .update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));
  }
}

export const activityService = new ActivityService();
