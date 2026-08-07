/**
 * Notifications, activity feed, and unsubscribe.
 *
 * The unsubscribe route is unauthenticated by design (FR-NOTIF-09): a one-click
 * link in an email cannot require a login. It is protected by an HMAC token
 * instead.
 */

import { Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { ListNotificationsQuery, TripIdParam } from '../../contracts/index';
import { db } from '../../platform/db/index';
import { notifications, trips, users } from '../../platform/db/schema/index';
import { signPayload, verifySignedPayload } from '../../platform/crypto/index';
import { validate, validated } from '../../platform/http/validate';
import { accessOf, withTripRead } from '../../platform/http/withTripAccess';
import { activityService } from './activity.service';

export const notificationsRouter = Router();

notificationsRouter.get(
  '/notifications',
  validate({ query: ListNotificationsQuery }),
  async (req, res) => {
    const { unreadOnly, limit } = validated.query(req, ListNotificationsQuery);

    const conditions = [eq(notifications.userId, req.ctx.userId)];
    if (unreadOnly === 'true') conditions.push(eq(notifications.isRead, false));

    const rows = await db
      .select({
        notification: notifications,
        tripTitle: trips.title,
        actorName: sql<string | null>`(
          select display_name from users u where u.id = notifications.actor_id)`,
      })
      .from(notifications)
      .leftJoin(trips, eq(trips.id, notifications.tripId))
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);

    res.json({
      items: rows.map((row) => ({
        id: row.notification.id,
        tripId: row.notification.tripId,
        tripTitle: row.tripTitle,
        kind: row.notification.kind,
        actorId: row.notification.actorId,
        actorName: row.actorName,
        body: row.notification.body,
        entityType: row.notification.entityType,
        entityId: row.notification.entityId,
        isRead: row.notification.isRead,
        createdAt: row.notification.createdAt.toISOString(),
      })),
      unreadCount: await activityService.unreadCount(db, req.ctx.userId),
    });
  },
);

notificationsRouter.post('/notifications/read', validate({}), async (req, res) => {
  await activityService.markAllRead(db, req.ctx.userId);
  res.status(204).end();
});

const NotificationIdParam = z.object({ id: z.string().uuid() });

notificationsRouter.post(
  '/notifications/:id/read',
  validate({ params: NotificationIdParam }),
  async (req, res) => {
    const { id } = validated.params(req, NotificationIdParam);
    // Scoped to the caller: you cannot mark someone else's notification read.
    await db
      .update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.id, id), eq(notifications.userId, req.ctx.userId)));
    res.status(204).end();
  },
);

/** FR-NOTIF-04 — the per-trip activity feed. */
notificationsRouter.get(
  '/trips/:tripId/activity',
  validate({ params: TripIdParam }),
  withTripRead('trip:view'),
  async (req, res) => {
    const events = await activityService.listForTrip(db, accessOf(req).tripId, 100);

    const actorIds = [...new Set(events.map((e) => e.actorId).filter(Boolean))] as string[];
    const names = new Map<string, string>();
    if (actorIds.length > 0) {
      const rows = await db
        .select({ id: users.id, name: users.displayName })
        .from(users)
        .where(sql`${users.id} in (${sql.join(actorIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
      for (const row of rows) names.set(row.id, row.name);
    }

    res.json({
      items: events.map((event) => ({
        id: String(event.id),
        kind: event.kind,
        entityType: event.entityType,
        entityId: event.entityId,
        actorId: event.actorId,
        actorName: event.actorId ? (names.get(event.actorId) ?? null) : null,
        createdAt: event.createdAt.toISOString(),
      })),
    });
  },
);

/**
 * One-click unsubscribe (FR-NOTIF-09).
 *
 * Unauthenticated on purpose — an email footer link cannot require a session.
 * The HMAC token is the authorization, and it only ever flips one boolean.
 */
export const unsubscribeRouter = Router();

const UnsubscribeParam = z.object({ token: z.string().min(10).max(400) });

unsubscribeRouter.get(
  '/unsubscribe/:token',
  validate({ params: UnsubscribeParam }),
  async (req, res) => {
    const { token } = validated.params(req, UnsubscribeParam);
    const payload = verifySignedPayload(token);

    if (!payload?.startsWith('unsub:')) {
      res.status(400).type('html').send('<p>This unsubscribe link is not valid.</p>');
      return;
    }

    await db
      .update(users)
      .set({ emailNotificationsEnabled: false })
      .where(eq(users.id, payload.slice('unsub:'.length)));

    res
      .type('html')
      .send(
        '<!doctype html><meta charset="utf-8"><title>Unsubscribed</title>' +
          '<body style="font-family:system-ui;display:grid;place-items:center;' +
          'min-height:100vh;margin:0;background:#0A0B0E;color:#F2F3F5">' +
          '<p>You will no longer receive Wandrly emails. ' +
          'You can turn them back on in Settings.</p></body>',
      );
  },
);

/** Used by the email templates to build the footer link. */
export const unsubscribeTokenFor = (userId: string): string => signPayload(`unsub:${userId}`);
