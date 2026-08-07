/**
 * Public share links and the server-rendered public page.
 *
 * TECHNICAL_DESIGN §8.7. Two absolutes:
 *
 *   • **The ledger is never in a public payload** (FR-SPLIT-40). Group finances
 *     are private to participants without exception — no toggle changes this.
 *     Stripped server-side, before the template sees the data.
 *
 *   • Booking details are excluded too (FR-SEC-09). They are confirmation
 *     numbers and seat assignments, not itinerary colour.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { background } from '../../platform/background';
import { env } from '../../platform/config/env';
import { hashPassword, newId, newSlug, sha256, verifyPassword } from '../../platform/crypto/index';
import { db, type Executor } from '../../platform/db/index';
import {
  blocks,
  comments,
  days,
  shareLinks,
  trips,
  users,
  variants,
} from '../../platform/db/schema/index';
import { ForbiddenError, NotFoundError } from '../../platform/errors/AppError';
import type { TripAccess } from '../../platform/policy/index';
import { activityService, type ActivityService } from '../notifications/activity.service';

export interface ShareSettings {
  isEnabled?: boolean;
  allowComments?: boolean;
  allowSuggestions?: boolean;
  password?: string | null;
  expiresAt?: string | null;
  variantId?: string | null;
}

/** Exactly what a stranger is allowed to see. */
export interface PublicTripView {
  slug: string;
  title: string;
  subtitle: string;
  destination: string;
  dateRangeLabel: string;
  startDate: string | null;
  endDate: string | null;
  coverHue: number;
  coverHue2: number;
  variantName: string;
  allowComments: boolean;
  allowSuggestions: boolean;
  days: {
    dayNumber: number;
    date: string | null;
    title: string;
    note: string;
    blocks: {
      id: string;
      type: string;
      title: string;
      timeLabel: string;
      meta: string;
      notes: string | null;
      isConfirmed: boolean;
      map: { lat: number; lng: number; name: string } | null;
      link: { url: string; host: string; title: string } | null;
      photoCount: number;
    }[];
  }[];
}

export class SharingService {
  constructor(private readonly activity: ActivityService) {}

  // ── Owner-facing management ───────────────────────────────────────

  async getLink(access: TripAccess) {
    const rows = await db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.tripId, access.tripId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create or update the trip's single share link.
   *
   * One link per trip (`one_link_per_trip`): regenerating replaces rather than
   * accumulating, so "who can see this" stays answerable.
   */
  async upsertLink(access: TripAccess, settings: ShareSettings) {
    const existing = await this.getLink(access);

    if (settings.variantId) {
      const variant = await db
        .select({ id: variants.id })
        .from(variants)
        .where(and(eq(variants.id, settings.variantId), eq(variants.tripId, access.tripId)))
        .limit(1);
      if (variant.length === 0) throw new NotFoundError('Variant');
    }

    const patch = {
      isEnabled: settings.isEnabled ?? existing?.isEnabled ?? true,
      allowComments: settings.allowComments ?? existing?.allowComments ?? false,
      allowSuggestions: settings.allowSuggestions ?? existing?.allowSuggestions ?? false,
      variantId: settings.variantId ?? existing?.variantId ?? null,
      expiresAt:
        settings.expiresAt === undefined
          ? (existing?.expiresAt ?? null)
          : settings.expiresAt
            ? new Date(settings.expiresAt)
            : null,
      ...(settings.password === undefined
        ? {}
        : { passwordHash: settings.password ? hashPassword(settings.password) : null }),
    };

    if (existing) {
      const [updated] = await db
        .update(shareLinks)
        .set(patch)
        .where(eq(shareLinks.id, existing.id))
        .returning();
      return updated!;
    }

    const [created] = await db
      .insert(shareLinks)
      .values({
        id: newId(),
        tripId: access.tripId,
        // 128 bits of randomness, base64url. Never sequential (FR-NFR-SEC-04).
        slug: newSlug(),
        createdBy: access.userId,
        ...patch,
      })
      .returning();

    await this.activity.record(db, {
      tripId: access.tripId,
      actorId: access.userId,
      kind: 'share.created',
      entityType: 'share_link',
      entityId: created!.id,
    });

    return created!;
  }

  async revokeLink(access: TripAccess): Promise<void> {
    const existing = await this.getLink(access);
    if (!existing) throw new NotFoundError('Share link');

    await db.delete(shareLinks).where(eq(shareLinks.id, existing.id));

    await this.activity.record(db, {
      tripId: access.tripId,
      actorId: access.userId,
      kind: 'share.revoked',
      entityType: 'share_link',
      entityId: existing.id,
    });
  }

  publicUrlFor(slug: string): string {
    return `${env.PUBLIC_BASE_URL}/p/${slug}`;
  }

  // ── Public resolution ─────────────────────────────────────────────

  /**
   * Resolve a slug to a viewable trip.
   *
   * Every failure mode returns the same `NotFoundError`, so a probe cannot
   * distinguish "no such link" from "disabled" or "expired".
   */
  async resolve(slug: string, password?: string): Promise<PublicTripView> {
    const rows = await db
      .select({ link: shareLinks, trip: trips })
      .from(shareLinks)
      .innerJoin(trips, eq(trips.id, shareLinks.tripId))
      .where(and(eq(shareLinks.slug, slug), isNull(trips.deletedAt)))
      .limit(1);

    const found = rows[0];
    if (!found || !found.link.isEnabled) throw new NotFoundError('Page');

    if (found.link.expiresAt && found.link.expiresAt.getTime() < Date.now()) {
      throw new NotFoundError('Page');
    }

    if (found.link.passwordHash) {
      if (!password || !verifyPassword(password, found.link.passwordHash)) {
        throw new ForbiddenError('share:password');
      }
    }

    const variantId = found.link.variantId ?? found.trip.mainVariantId;
    if (!variantId) throw new NotFoundError('Page');

    const view = await this.buildView(db, found.trip, found.link, variantId);

    // Fire-and-forget: a view counter must never slow or fail the page — but
    // it is tracked, so tests can wait for it to settle (see platform/background).
    background(
      db
        .update(shareLinks)
        .set({ viewCount: sql`${shareLinks.viewCount} + 1` })
        .where(eq(shareLinks.id, found.link.id)),
      'share.viewCount',
    );

    return view;
  }

  private async buildView(
    exec: Executor,
    trip: typeof trips.$inferSelect,
    link: typeof shareLinks.$inferSelect,
    variantId: string,
  ): Promise<PublicTripView> {
    const [variant] = await exec
      .select({ name: variants.name })
      .from(variants)
      .where(eq(variants.id, variantId))
      .limit(1);

    const dayRows = await exec
      .select()
      .from(days)
      .where(eq(days.variantId, variantId))
      .orderBy(asc(days.dayNumber));

    const blockRows =
      dayRows.length === 0
        ? []
        : await exec
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

    const byDay = new Map<string, typeof blockRows>();
    for (const block of blockRows) {
      const list = byDay.get(block.dayId) ?? [];
      list.push(block);
      byDay.set(block.dayId, list);
    }

    const { formatDateRange } = await import('../trips/date-utils');

    return {
      slug: link.slug,
      title: trip.title,
      subtitle: trip.subtitle,
      destination: trip.destination,
      dateRangeLabel: formatDateRange(trip.startDate, trip.endDate),
      startDate: trip.startDate,
      endDate: trip.endDate,
      coverHue: trip.coverHue,
      coverHue2: trip.coverHue2,
      variantName: variant?.name ?? 'Main',
      allowComments: link.allowComments,
      allowSuggestions: link.allowSuggestions,
      days: dayRows.map((day) => ({
        dayNumber: day.dayNumber,
        date: day.date,
        title: day.title,
        note: day.note,
        blocks: (byDay.get(day.id) ?? []).map((block) => {
          const sections = (block.sections ?? {}) as Record<string, unknown>;
          const map = sections.map as PublicTripView['days'][0]['blocks'][0]['map'];
          const linkSection = sections.link as { url: string; host: string; title: string } | undefined;

          return {
            id: block.id,
            type: block.type,
            title: block.title,
            timeLabel: block.timeLabel,
            meta: block.meta,
            notes: block.notes,
            isConfirmed: block.isConfirmed,
            map: map ?? null,
            link: linkSection
              ? { url: linkSection.url, host: linkSection.host, title: linkSection.title }
              : null,
            photoCount: Array.isArray(sections.photos) ? sections.photos.length : 0,
            // `booking` and `cost` are deliberately absent — they never leave
            // the server for a public viewer (FR-SEC-09, FR-SPLIT-40).
          };
        }),
      })),
    };
  }

  // ── Guest participation (FR-SHARE-05/06) ──────────────────────────

  /**
   * A comment from someone with no account.
   *
   * They get a guest token so they can edit or delete their own contribution
   * later — the alternative is "no editing" or "anyone can edit anything".
   */
  async guestComment(
    slug: string,
    input: { guestName: string; body: string; blockId?: string | null },
  ) {
    const rows = await db
      .select({ link: shareLinks })
      .from(shareLinks)
      .where(eq(shareLinks.slug, slug))
      .limit(1);

    const link = rows[0]?.link;
    if (!link || !link.isEnabled) throw new NotFoundError('Page');
    if (!link.allowComments) throw new ForbiddenError('comment:create');

    const guestToken = newSlug();
    const commentId = newId();

    await db.insert(comments).values({
      id: commentId,
      tripId: link.tripId,
      blockId: input.blockId ?? null,
      guestName: input.guestName,
      guestTokenHash: sha256(guestToken),
      body: input.body,
    });

    await this.activity.notify(db, {
      tripId: link.tripId,
      actorId: null,
      kind: 'COMMENT',
      entityType: 'comment',
      entityId: commentId,
      body: `${input.guestName} commented via the share link`,
    });

    return { id: commentId, guestToken };
  }

  async deleteGuestComment(slug: string, commentId: string, guestToken: string): Promise<void> {
    const rows = await db
      .select({ tripId: shareLinks.tripId })
      .from(shareLinks)
      .where(eq(shareLinks.slug, slug))
      .limit(1);

    if (rows.length === 0) throw new NotFoundError('Page');

    const [comment] = await db
      .select({ guestTokenHash: comments.guestTokenHash })
      .from(comments)
      .where(and(eq(comments.id, commentId), eq(comments.tripId, rows[0]!.tripId)))
      .limit(1);

    if (!comment) throw new NotFoundError('Comment');
    if (comment.guestTokenHash !== sha256(guestToken)) {
      throw new ForbiddenError('comment:delete');
    }

    await db.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, commentId));
  }

  /** Public comments on a shared trip, for display on the public page. */
  async publicComments(slug: string) {
    const rows = await db
      .select({ link: shareLinks })
      .from(shareLinks)
      .where(eq(shareLinks.slug, slug))
      .limit(1);

    const link = rows[0]?.link;
    if (!link || !link.isEnabled || !link.allowComments) return [];

    return db
      .select({
        id: comments.id,
        blockId: comments.blockId,
        body: comments.body,
        authorName: sql<string>`coalesce(
          (select display_name from users where users.id = comments.author_id),
          comments.guest_name, 'Someone')`,
        createdAt: comments.createdAt,
      })
      .from(comments)
      .where(
        and(
          eq(comments.tripId, link.tripId),
          isNull(comments.deletedAt),
          isNull(comments.resolvedAt),
        ),
      )
      .orderBy(asc(comments.createdAt))
      .limit(200);
  }

  /** Owner display name, for the public page byline. */
  async ownerNameFor(slug: string): Promise<string> {
    const rows = await db
      .select({ name: users.displayName })
      .from(shareLinks)
      .innerJoin(trips, eq(trips.id, shareLinks.tripId))
      .innerJoin(users, eq(users.id, trips.ownerId))
      .where(eq(shareLinks.slug, slug))
      .limit(1);
    return rows[0]?.name ?? 'A traveller';
  }
}

export const sharingService = new SharingService(activityService);
