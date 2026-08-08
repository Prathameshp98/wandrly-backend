/**
 * Collaboration — members, invites, comments, suggestions.
 *
 * Three rules that shape this module:
 *
 *   • Invite tokens are stored HASHED. A database read must never yield a
 *     usable join link.
 *   • A trip always has exactly one Owner. Demoting or removing one is only
 *     possible by transferring ownership first — enforced here, and backed by
 *     the `one_owner_per_trip` partial unique index.
 *   • Accepting an invite can claim a ledger placeholder, transferring that
 *     person's entire expense history onto their new account (FR-SPLIT-03).
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { limits } from '../../platform/config/env';
import { env } from '../../platform/config/env';
import { newId, newToken, sha256 } from '../../platform/crypto/index';
import { db, withTransaction, type Executor } from '../../platform/db/index';
import {
  blocks,
  comments,
  invites,
  suggestions,
  tripMembers,
  tripParticipants,
  trips,
  users,
} from '../../platform/db/schema/index';
import {
  DomainRuleError,
  DuplicateError,
  ForbiddenError,
  LimitExceededError,
  NotFoundError,
} from '../../platform/errors/AppError';
import { emailService, inviteEmail, type EmailService } from '../../platform/email/email.service';
import { DeferredBroadcast } from '../../platform/realtime/hub';
import { assert, type Role, type TripAccess } from '../../platform/policy/index';
import type {
  CreateCommentBody,
  CreateSuggestionBody,
  ReviewSuggestionBody,
  SendInvitesBody,
} from '../../contracts/collab';
import { activityService, type ActivityService } from '../notifications/activity.service';

const INVITE_TTL_DAYS = 30;
const PRESENCE_WINDOW_MS = 5 * 60 * 1000;

export interface CollabServiceDeps {
  readonly activity: ActivityService;
  readonly email: EmailService;
}

export class CollabService {
  constructor(private readonly deps: CollabServiceDeps) {}

  // ── Members ───────────────────────────────────────────────────────

  async listMembers(access: TripAccess) {
    const rows = await db
      .select({
        userId: users.id,
        displayName: users.displayName,
        email: users.email,
        avatarTone: users.avatarTone,
        role: tripMembers.role,
        joinedAt: tripMembers.joinedAt,
        lastActiveAt: tripMembers.lastActiveAt,
        participantId: tripParticipants.id,
      })
      .from(tripMembers)
      .innerJoin(users, eq(users.id, tripMembers.userId))
      .leftJoin(
        tripParticipants,
        and(
          eq(tripParticipants.tripId, tripMembers.tripId),
          eq(tripParticipants.userId, tripMembers.userId),
        ),
      )
      .where(eq(tripMembers.tripId, access.tripId))
      .orderBy(tripMembers.joinedAt);

    const now = Date.now();
    return rows.map((row) => ({
      ...row,
      isLive:
        row.lastActiveAt !== null &&
        now - row.lastActiveAt.getTime() < PRESENCE_WINDOW_MS,
    }));
  }

  /** FR-COLLAB-05 — only the Owner changes roles, and never their own. */
  async changeRole(access: TripAccess, targetUserId: string, role: Role) {
    if (role === 'OWNER') {
      throw new DomainRuleError(
        'Use ownership transfer to make someone the owner, so the trip always has exactly one.',
      );
    }
    if (targetUserId === access.userId) {
      throw new DomainRuleError('You cannot change your own role');
    }

    const [updated] = await db
      .update(tripMembers)
      .set({ role })
      .where(and(eq(tripMembers.tripId, access.tripId), eq(tripMembers.userId, targetUserId)))
      .returning();

    if (!updated) throw new NotFoundError('Member');

    await this.deps.activity.record(db, {
      tripId: access.tripId,
      actorId: access.userId,
      kind: 'member.role-changed',
      entityType: 'member',
      entityId: targetUserId,
      after: { role },
    });

    return updated;
  }

  /**
   * FR-COLLAB-12 — transfer ownership.
   *
   * Clear-then-set inside one transaction: `one_owner_per_trip` is a partial
   * unique index, so two owners must not exist even momentarily.
   */
  private async countPendingInvites(exec: Executor, tripId: string): Promise<number> {
    const rows = await exec
      .select({ count: sql<number>`count(*)::int` })
      .from(invites)
      .where(and(eq(invites.tripId, tripId), eq(invites.status, 'PENDING')));
    return rows[0]?.count ?? 0;
  }

  /**
   * A claim may only ever target an unclaimed placeholder on this trip.
   *
   * 404 for "not on this trip" rather than 422, so an invite cannot be used to
   * probe for participant ids on trips the sender has no access to.
   */
  private async requireClaimablePlaceholder(
    exec: Executor,
    tripId: string,
    participantId: string,
  ): Promise<void> {
    const rows = await exec
      .select({ userId: tripParticipants.userId, isActive: tripParticipants.isActive })
      .from(tripParticipants)
      .where(
        and(
          eq(tripParticipants.id, participantId),
          eq(tripParticipants.tripId, tripId),
        ),
      )
      .limit(1);

    const participant = rows[0];
    if (!participant) throw new NotFoundError('Participant');

    if (participant.userId !== null) {
      throw new DomainRuleError(
        'That person already has an account on this trip, so their share cannot be claimed',
      );
    }

    if (!participant.isActive) {
      throw new DomainRuleError('That participant has been removed from this trip');
    }
  }

  async transferOwnership(access: TripAccess, toUserId: string) {
    // A no-op in practice — the clear-then-set below would demote and re-promote
    // the same person — but it writes an activity event claiming a handover
    // that never happened.
    if (toUserId === access.userId) {
      throw new DomainRuleError('You are already the owner of this trip');
    }

    await withTransaction(async (tx) => {
      const target = await tx
        .select({ userId: tripMembers.userId })
        .from(tripMembers)
        .where(and(eq(tripMembers.tripId, access.tripId), eq(tripMembers.userId, toUserId)))
        .limit(1);

      if (target.length === 0) {
        throw new DomainRuleError('Ownership can only pass to an existing member');
      }

      await tx
        .update(tripMembers)
        .set({ role: 'EDITOR' })
        .where(and(eq(tripMembers.tripId, access.tripId), eq(tripMembers.userId, access.userId)));

      await tx
        .update(tripMembers)
        .set({ role: 'OWNER' })
        .where(and(eq(tripMembers.tripId, access.tripId), eq(tripMembers.userId, toUserId)));

      await tx.update(trips).set({ ownerId: toUserId }).where(eq(trips.id, access.tripId));

      await this.deps.activity.record(tx, {
        tripId: access.tripId,
        actorId: access.userId,
        kind: 'trip.ownership-transferred',
        entityType: 'trip',
        entityId: access.tripId,
        after: { toUserId },
      });
    });
  }

  /**
   * FR-COLLAB-04 / FR-SPLIT-05 — removing someone from the crew does NOT remove
   * them from the ledger. They keep their balances and stay a participant until
   * settled, otherwise leaving a trip would erase money owed.
   */
  async removeMember(access: TripAccess, targetUserId: string) {
    if (targetUserId === access.userId) {
      throw new DomainRuleError('Leave the trip instead of removing yourself');
    }

    const rows = await db
      .select({ role: tripMembers.role })
      .from(tripMembers)
      .where(and(eq(tripMembers.tripId, access.tripId), eq(tripMembers.userId, targetUserId)))
      .limit(1);

    const member = rows[0];
    if (!member) throw new NotFoundError('Member');
    if (member.role === 'OWNER') {
      throw new DomainRuleError('Transfer ownership before removing the owner');
    }

    await db
      .delete(tripMembers)
      .where(and(eq(tripMembers.tripId, access.tripId), eq(tripMembers.userId, targetUserId)));

    await this.deps.activity.record(db, {
      tripId: access.tripId,
      actorId: access.userId,
      kind: 'member.removed',
      entityType: 'member',
      entityId: targetUserId,
    });
  }

  /** Heartbeat for the presence ring (§9). */
  async touchPresence(access: TripAccess): Promise<void> {
    await db
      .update(tripMembers)
      .set({ lastActiveAt: new Date() })
      .where(
        and(eq(tripMembers.tripId, access.tripId), eq(tripMembers.userId, access.userId)),
      );
  }

  // ── Invites ───────────────────────────────────────────────────────

  async sendInvites(access: TripAccess, input: SendInvitesBody) {
    const created: { email: string; id: string }[] = [];

    const trip = await db
      .select({ title: trips.title })
      .from(trips)
      .where(eq(trips.id, access.tripId))
      .limit(1);

    const inviter = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, access.userId))
      .limit(1);

    // Pending invites count too. Checking members alone made the ceiling
    // bypassable by simply inviting past it: nothing stopped 49 invites, then
    // 49 more, then everybody accepting.
    const [memberCount, pendingCount] = await Promise.all([
      this.countMembers(db, access.tripId),
      this.countPendingInvites(db, access.tripId),
    ]);

    if (memberCount + pendingCount + input.emails.length > limits.membersPerTrip) {
      throw new LimitExceededError('people on a trip', limits.membersPerTrip);
    }

    // `claimsParticipantId` decides whose ledger history the accepter inherits,
    // and it arrives from the client. Unchecked, it was two attacks at once: a
    // participant id from ANOTHER trip reassigned someone else's ledger
    // identity in a trip the sender cannot even see, and an id belonging to an
    // existing member handed their balances to whoever accepted.
    if (input.claimsParticipantId) {
      await this.requireClaimablePlaceholder(db, access.tripId, input.claimsParticipantId);
    }

    for (const email of input.emails) {
      const normalised = email.trim().toLowerCase();

      // Already a member? Silently skip rather than leaking who is on the trip.
      const existing = await db
        .select({ userId: tripMembers.userId })
        .from(tripMembers)
        .innerJoin(users, eq(users.id, tripMembers.userId))
        .where(and(eq(tripMembers.tripId, access.tripId), eq(users.email, normalised)))
        .limit(1);

      if (existing.length > 0) continue;

      const token = newToken();
      const id = newId();
      const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);

      try {
        await db.insert(invites).values({
          id,
          tripId: access.tripId,
          email: normalised,
          role: input.role,
          personalNote: input.personalNote ?? null,
          // Hashed: a DB read must not yield a usable join link.
          tokenHash: sha256(token),
          claimsParticipantId: input.claimsParticipantId ?? null,
          expiresAt,
          sentBy: access.userId,
        });
      } catch {
        // `one_pending_invite` unique index — re-inviting is a no-op, not an error.
        continue;
      }

      const message = inviteEmail({
        tripTitle: trip[0]?.title ?? 'a trip',
        inviterName: inviter[0]?.displayName ?? 'Someone',
        role: input.role,
        personalNote: input.personalNote,
        joinUrl: `${env.PUBLIC_BASE_URL}/invite/${token}`,
      });

      await this.deps.email.send({ to: normalised, ...message });

      created.push({ email: normalised, id });
    }

    await this.deps.activity.record(db, {
      tripId: access.tripId,
      actorId: access.userId,
      kind: 'invite.sent',
      entityType: 'invite',
      after: { count: created.length, role: input.role },
    });

    return created;
  }

  /** Invites addressed to the caller's verified email (FR-COLLAB-10). */
  async listMyInvites(userId: string) {
    const rows = await db
      .select({
        invite: invites,
        tripTitle: trips.title,
        inviterName: users.displayName,
      })
      .from(invites)
      .innerJoin(trips, eq(trips.id, invites.tripId))
      .innerJoin(users, eq(users.id, invites.sentBy))
      .where(
        and(
          eq(invites.status, 'PENDING'),
          sql`${invites.email} = (select email from users where id = ${userId})`,
          sql`${invites.expiresAt} > now()`,
        ),
      )
      .orderBy(desc(invites.sentAt));

    return rows;
  }

  async listTripInvites(access: TripAccess) {
    return db
      .select()
      .from(invites)
      .where(and(eq(invites.tripId, access.tripId), eq(invites.status, 'PENDING')))
      .orderBy(desc(invites.sentAt));
  }

  /**
   * Accept an invite by its emailed token.
   *
   * Not behind `withTripAccess`: the whole point is that the caller is not yet a
   * member. Authorization is the token itself, plus a check that it was
   * addressed to this user's email.
   */
  async acceptInvite(userId: string, token: string) {
    return withTransaction(async (tx) => {
      const rows = await tx
        .select()
        .from(invites)
        .where(eq(invites.tokenHash, sha256(token)))
        .limit(1);

      const invite = rows[0];
      if (!invite) throw new NotFoundError('Invite');

      if (invite.status !== 'PENDING') {
        throw new DomainRuleError('This invite has already been used');
      }
      if (invite.expiresAt.getTime() < Date.now()) {
        await tx.update(invites).set({ status: 'EXPIRED' }).where(eq(invites.id, invite.id));
        throw new DomainRuleError('This invite has expired. Ask for a new one.');
      }

      const user = await tx
        .select({ email: users.email, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      // The invite belongs to an email address, not to whoever holds the link.
      if (user[0]?.email?.toLowerCase() !== invite.email.toLowerCase()) {
        throw new ForbiddenError('invite:accept');
      }

      const already = await tx
        .select({ userId: tripMembers.userId })
        .from(tripMembers)
        .where(and(eq(tripMembers.tripId, invite.tripId), eq(tripMembers.userId, userId)))
        .limit(1);

      if (already.length > 0) {
        throw new DuplicateError('You are already on this trip');
      }

      // The real ceiling lives here rather than at send time: invites can be
      // sent before other people accept, so this is the only point at which
      // the membership count is final.
      const memberCount = await this.countMembers(tx, invite.tripId);
      if (memberCount >= limits.membersPerTrip) {
        throw new LimitExceededError('people on a trip', limits.membersPerTrip);
      }

      await tx.insert(tripMembers).values({
        tripId: invite.tripId,
        userId,
        role: invite.role,
        invitedBy: invite.sentBy,
      });

      // FR-SPLIT-03 — claiming a placeholder transfers their entire ledger
      // history onto this account, with no recomputation of balances.
      if (invite.claimsParticipantId) {
        // Re-checked here as well as at send time: the placeholder can be
        // claimed by someone else in between, and this is the moment the
        // ledger history actually moves.
        await this.requireClaimablePlaceholder(
          tx,
          invite.tripId,
          invite.claimsParticipantId,
        );

        await tx
          .update(tripParticipants)
          .set({
            userId,
            claimedAt: new Date(),
            displayName: user[0]?.displayName ?? 'Traveller',
          })
          .where(eq(tripParticipants.id, invite.claimsParticipantId));
      } else {
        await tx.insert(tripParticipants).values({
          id: newId(),
          tripId: invite.tripId,
          userId,
          displayName: user[0]?.displayName ?? 'Traveller',
          createdBy: userId,
        });
      }

      await tx
        .update(invites)
        .set({ status: 'ACCEPTED', respondedAt: new Date() })
        .where(eq(invites.id, invite.id));

      await this.deps.activity.record(tx, {
        tripId: invite.tripId,
        actorId: userId,
        kind: 'invite.accepted',
        entityType: 'invite',
        entityId: invite.id,
        after: { role: invite.role, claimedParticipant: Boolean(invite.claimsParticipantId) },
      });

      await this.deps.activity.notify(tx, {
        tripId: invite.tripId,
        actorId: userId,
        kind: 'INVITE',
        body: `joined the trip`,
        userIds: [invite.sentBy],
      });

      return { tripId: invite.tripId, role: invite.role };
    });
  }

  async declineInvite(userId: string, token: string): Promise<void> {
    const rows = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, sha256(token)))
      .limit(1);

    const invite = rows[0];
    if (!invite || invite.status !== 'PENDING') throw new NotFoundError('Invite');

    const user = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (user[0]?.email?.toLowerCase() !== invite.email.toLowerCase()) {
      throw new ForbiddenError('invite:decline');
    }

    await db
      .update(invites)
      .set({ status: 'DECLINED', respondedAt: new Date() })
      .where(eq(invites.id, invite.id));
  }

  async revokeInvite(access: TripAccess, inviteId: string): Promise<void> {
    const [updated] = await db
      .update(invites)
      .set({ status: 'REVOKED', respondedAt: new Date() })
      .where(
        and(
          eq(invites.id, inviteId),
          eq(invites.tripId, access.tripId),
          eq(invites.status, 'PENDING'),
        ),
      )
      .returning();

    if (!updated) throw new NotFoundError('Invite');
  }

  // ── Comments ──────────────────────────────────────────────────────

  async listComments(
    access: TripAccess,
    options: { blockId?: string; includeResolved: boolean },
  ) {
    const conditions = [eq(comments.tripId, access.tripId), isNull(comments.deletedAt)];
    if (options.blockId) conditions.push(eq(comments.blockId, options.blockId));
    if (!options.includeResolved) conditions.push(isNull(comments.resolvedAt));

    return db
      .select({
        comment: comments,
        authorName: sql<string>`coalesce(
          (select display_name from users where users.id = comments.author_id),
          comments.guest_name,
          'Someone')`,
      })
      .from(comments)
      .where(and(...conditions))
      .orderBy(comments.createdAt);
  }

  async createComment(access: TripAccess, input: CreateCommentBody) {
    const commentId = newId();
    const broadcast = new DeferredBroadcast();

    await withTransaction(async (tx) => {
      if (input.blockId) {
        const block = await tx
          .select({ id: blocks.id })
          .from(blocks)
          .where(and(eq(blocks.id, input.blockId), isNull(blocks.deletedAt)))
          .limit(1);
        if (block.length === 0) throw new NotFoundError('Block');
      }

      // One level of threading only (FR-COLLAB-09): a reply to a reply would
      // make the UI unbounded, so it is rejected rather than silently flattened.
      if (input.parentCommentId) {
        const parent = await tx
          .select({ parentCommentId: comments.parentCommentId })
          .from(comments)
          .where(eq(comments.id, input.parentCommentId))
          .limit(1);

        if (parent.length === 0) throw new NotFoundError('Parent comment');
        if (parent[0]!.parentCommentId !== null) {
          throw new DomainRuleError('Replies cannot be nested more than one level deep');
        }
      }

      await tx.insert(comments).values({
        id: commentId,
        tripId: access.tripId,
        blockId: input.blockId ?? null,
        parentCommentId: input.parentCommentId ?? null,
        authorId: access.userId,
        body: input.body,
        mentionedUserIds: input.mentionedUserIds,
      });

      await this.deps.activity.notify(tx, {
        tripId: access.tripId,
        actorId: access.userId,
        kind: 'COMMENT',
        entityType: 'comment',
        entityId: commentId,
        body: 'commented on this trip',
      });

      // @-mentions notify immediately rather than in the 30-minute digest.
      if (input.mentionedUserIds.length > 0) {
        await this.deps.activity.notify(tx, {
          tripId: access.tripId,
          actorId: access.userId,
          kind: 'MENTION',
          entityType: 'comment',
          entityId: commentId,
          body: 'mentioned you in a comment',
          userIds: input.mentionedUserIds,
        });
      }

      broadcast.queue({
        kind: 'comment.created',
        tripId: access.tripId,
        entityId: commentId,
        actorId: access.userId,
      });
    });

    broadcast.flush();
    return this.findComment(commentId);
  }

  async updateComment(access: TripAccess, commentId: string, body: string) {
    const existing = await this.requireComment(access.tripId, commentId);

    if (existing.authorId !== access.userId) {
      throw new ForbiddenError('comment:edit');
    }

    await db
      .update(comments)
      .set({ body, updatedAt: new Date() })
      .where(eq(comments.id, commentId));

    return this.findComment(commentId);
  }

  async resolveComment(access: TripAccess, commentId: string, resolved: boolean) {
    const existing = await this.requireComment(access.tripId, commentId);

    // Contributors may only resolve their own threads; Viewers not at all.
    assert(access, 'comment:resolve-any', { createdBy: existing.authorId });

    await db
      .update(comments)
      .set({
        resolvedAt: resolved ? new Date() : null,
        resolvedBy: resolved ? access.userId : null,
      })
      .where(eq(comments.id, commentId));

    return this.findComment(commentId);
  }

  async deleteComment(access: TripAccess, commentId: string): Promise<void> {
    const existing = await this.requireComment(access.tripId, commentId);

    if (existing.authorId !== access.userId && access.role !== 'OWNER') {
      throw new ForbiddenError('comment:delete');
    }

    await db.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, commentId));
  }

  // ── Suggestions ───────────────────────────────────────────────────

  async listSuggestions(access: TripAccess, status?: string) {
    const conditions = [eq(suggestions.tripId, access.tripId)];
    if (status) conditions.push(eq(suggestions.status, status as never));

    return db
      .select({
        suggestion: suggestions,
        proposerName: sql<string>`coalesce(
          (select display_name from users where users.id = suggestions.proposed_by),
          suggestions.guest_name,
          'Someone')`,
      })
      .from(suggestions)
      .where(and(...conditions))
      .orderBy(desc(suggestions.createdAt));
  }

  async createSuggestion(access: TripAccess, input: CreateSuggestionBody) {
    const suggestionId = newId();

    await withTransaction(async (tx) => {
      await tx.insert(suggestions).values({
        id: suggestionId,
        tripId: access.tripId,
        dayId: input.dayId ?? null,
        proposedBlock: input.proposedBlock as never,
        rationale: input.rationale ?? null,
        proposedBy: access.userId,
      });

      await this.deps.activity.notify(tx, {
        tripId: access.tripId,
        actorId: access.userId,
        kind: 'BLOCK',
        entityType: 'suggestion',
        entityId: suggestionId,
        body: `suggested "${input.proposedBlock.title || 'a new block'}"`,
      });
    });

    return this.findSuggestion(suggestionId);
  }

  /**
   * FR-COLLAB-08 — accepting materialises the proposed block for real.
   *
   * The suggestion keeps a pointer to what it created, so the review queue can
   * show the outcome rather than just "accepted".
   */
  async reviewSuggestion(
    access: TripAccess,
    suggestionId: string,
    input: ReviewSuggestionBody,
  ) {
    const broadcast = new DeferredBroadcast();

    await withTransaction(async (tx) => {
      const rows = await tx
        .select()
        .from(suggestions)
        .where(and(eq(suggestions.id, suggestionId), eq(suggestions.tripId, access.tripId)))
        .limit(1);

      const suggestion = rows[0];
      if (!suggestion) throw new NotFoundError('Suggestion');
      if (suggestion.status !== 'PENDING') {
        throw new DomainRuleError('This suggestion has already been reviewed');
      }

      let createdBlockId: string | null = null;

      if (input.decision === 'ACCEPT') {
        const dayId = input.dayId ?? suggestion.dayId;
        if (!dayId) {
          throw new DomainRuleError('Choose which day this block should be added to');
        }

        const day = await tx
          .select({ id: sql<string>`days.id` })
          .from(sql`days`)
          .innerJoin(sql`variants`, sql`variants.id = days.variant_id`)
          .where(sql`days.id = ${dayId} and variants.trip_id = ${access.tripId}`)
          .limit(1);

        if (day.length === 0) throw new NotFoundError('Day');

        const proposed = suggestion.proposedBlock as Record<string, unknown>;
        createdBlockId = newId();

        const [maxRow] = await tx
          .select({ max: sql<number>`coalesce(max(${blocks.sortOrder}), 0)::int` })
          .from(blocks)
          .where(and(eq(blocks.dayId, dayId), isNull(blocks.deletedAt)));

        await tx.insert(blocks).values({
          id: createdBlockId,
          dayId,
          type: (proposed.type ?? 'NOTE') as never,
          title: String(proposed.title ?? ''),
          timeLabel: String(proposed.timeLabel ?? ''),
          meta: String(proposed.meta ?? ''),
          notes: (proposed.notes as string) ?? null,
          isConfirmed: Boolean(proposed.isConfirmed),
          sortOrder: (maxRow?.max ?? 0) + 1000,
          sections: (proposed.sections ?? {}) as never,
          // Attributed to the proposer, not the reviewer — they wrote it.
          createdBy: suggestion.proposedBy,
        });

        broadcast.queue({
          kind: 'block.created',
          tripId: access.tripId,
          entityId: createdBlockId,
          actorId: access.userId,
        });
      }

      await tx
        .update(suggestions)
        .set({
          status: input.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED',
          reviewedBy: access.userId,
          reviewReason: input.reason ?? null,
          reviewedAt: new Date(),
          createdBlockId,
        })
        .where(eq(suggestions.id, suggestionId));

      if (suggestion.proposedBy) {
        await this.deps.activity.notify(tx, {
          tripId: access.tripId,
          actorId: access.userId,
          kind: 'BLOCK',
          entityType: 'suggestion',
          entityId: suggestionId,
          body:
            input.decision === 'ACCEPT'
              ? 'accepted your suggestion'
              : 'declined your suggestion',
          userIds: [suggestion.proposedBy],
        });
      }

      broadcast.queue({
        kind: 'suggestion.reviewed',
        tripId: access.tripId,
        entityId: suggestionId,
        actorId: access.userId,
      });
    });

    broadcast.flush();
    return this.findSuggestion(suggestionId);
  }

  async withdrawSuggestion(access: TripAccess, suggestionId: string): Promise<void> {
    const rows = await db
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.id, suggestionId), eq(suggestions.tripId, access.tripId)))
      .limit(1);

    const suggestion = rows[0];
    if (!suggestion) throw new NotFoundError('Suggestion');
    if (suggestion.proposedBy !== access.userId) throw new ForbiddenError('suggestion:withdraw');

    await db
      .update(suggestions)
      .set({ status: 'WITHDRAWN' })
      .where(eq(suggestions.id, suggestionId));
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async countMembers(exec: Executor, tripId: string): Promise<number> {
    const [row] = await exec
      .select({ count: sql<number>`count(*)::int` })
      .from(tripMembers)
      .where(eq(tripMembers.tripId, tripId));
    return row?.count ?? 0;
  }

  private async requireComment(tripId: string, commentId: string) {
    const rows = await db
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.id, commentId),
          eq(comments.tripId, tripId),
          isNull(comments.deletedAt),
        ),
      )
      .limit(1);

    const comment = rows[0];
    if (!comment) throw new NotFoundError('Comment');
    return comment;
  }

  private async findComment(commentId: string) {
    const rows = await db
      .select({
        comment: comments,
        authorName: sql<string>`coalesce(
          (select display_name from users where users.id = comments.author_id),
          comments.guest_name,
          'Someone')`,
      })
      .from(comments)
      .where(eq(comments.id, commentId))
      .limit(1);
    return rows[0]!;
  }

  private async findSuggestion(suggestionId: string) {
    const rows = await db
      .select({
        suggestion: suggestions,
        proposerName: sql<string>`coalesce(
          (select display_name from users where users.id = suggestions.proposed_by),
          suggestions.guest_name,
          'Someone')`,
      })
      .from(suggestions)
      .where(eq(suggestions.id, suggestionId))
      .limit(1);
    return rows[0]!;
  }
}

export const collabService = new CollabService({
  activity: activityService,
  email: emailService,
});
