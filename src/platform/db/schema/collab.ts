/**
 * Collaboration, sharing, notifications, and the audit log.
 * TECHNICAL_DESIGN §5.6, §5.8.
 */

import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  citext,
  emailStateEnum,
  inviteStatusEnum,
  memberRoleEnum,
  notificationKindEnum,
  suggestionStatusEnum,
} from './enums';
import { blocks, days, variants } from './canvas';
import { tripParticipants } from './ledger';
import { trips } from './trips';
import { users } from './identity';

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    email: citext('email').notNull(),
    role: memberRoleEnum('role').notNull(),
    personalNote: text('personal_note'),
    /** SHA-256 of the emailed token. A DB read must not yield a usable link. */
    tokenHash: text('token_hash').notNull(),
    status: inviteStatusEnum('status').notNull().default('PENDING'),
    /** Optional ledger placeholder this invite would claim (FR-SPLIT-03). */
    claimsParticipantId: uuid('claims_participant_id').references(() => tripParticipants.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    sentBy: uuid('sent_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('invites_token_uq').on(t.tokenHash),
    uniqueIndex('one_pending_invite')
      .on(t.tripId, t.email)
      .where(sql`${t.status} = 'PENDING'`),
    index('invites_email_idx')
      .on(t.email)
      .where(sql`${t.status} = 'PENDING'`),
  ],
);

export const shareLinks = pgTable(
  'share_links',
  {
    id: uuid('id').primaryKey(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    /** Which variant is public. Defaults to main (FR-VAR-09). */
    variantId: uuid('variant_id').references(() => variants.id, { onDelete: 'set null' }),
    /** 128-bit random, base64url. Never sequential (FR-NFR-SEC-04). */
    slug: text('slug').notNull(),
    isEnabled: boolean('is_enabled').notNull().default(true),
    allowComments: boolean('allow_comments').notNull().default(false),
    allowSuggestions: boolean('allow_suggestions').notNull().default(false),
    passwordHash: text('password_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    viewCount: integer('view_count').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('share_links_slug_uq').on(t.slug),
    // One live link per trip keeps the mental model simple; regenerating replaces.
    uniqueIndex('one_link_per_trip').on(t.tripId),
  ],
);

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    /** Null ⇒ a trip-level comment. */
    blockId: uuid('block_id').references(() => blocks.id, { onDelete: 'cascade' }),
    parentCommentId: uuid('parent_comment_id'),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    /** Public-link commenter (FR-SHARE-05). */
    guestName: text('guest_name'),
    /** Lets a guest edit or delete their own contribution without an account. */
    guestTokenHash: text('guest_token_hash'),
    body: text('body').notNull(),
    mentionedUserIds: uuid('mentioned_user_ids').array().notNull().default(sql`'{}'::uuid[]`),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('comments_block_idx')
      .on(t.blockId)
      .where(sql`${t.deletedAt} is null`),
    index('comments_trip_idx')
      .on(t.tripId, t.createdAt)
      .where(sql`${t.deletedAt} is null`),
    check('comments_body_len', sql`char_length(${t.body}) between 1 and 2000`),
    check('comments_author', sql`${t.authorId} is not null or ${t.guestName} is not null`),
  ],
);

export const suggestions = pgTable(
  'suggestions',
  {
    id: uuid('id').primaryKey(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    dayId: uuid('day_id').references(() => days.id, { onDelete: 'set null' }),
    /** Same shape as a block plus its sections. */
    proposedBlock: jsonb('proposed_block').notNull(),
    rationale: text('rationale'),
    proposedBy: uuid('proposed_by').references(() => users.id, { onDelete: 'set null' }),
    guestName: text('guest_name'),
    status: suggestionStatusEnum('status').notNull().default('PENDING'),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewReason: text('review_reason'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdBlockId: uuid('created_block_id').references(() => blocks.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('suggestions_trip_status_idx').on(t.tripId, t.status)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tripId: uuid('trip_id').references(() => trips.id, { onDelete: 'cascade' }),
    kind: notificationKindEnum('kind').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    body: text('body').notNull(),
    isRead: boolean('is_read').notNull().default(false),
    /** Drives the batching rules in §10.3. */
    emailState: emailStateEnum('email_state').notNull().default('NOT_REQUIRED'),
    emailSentAt: timestamp('email_sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, t.createdAt),
    index('notifications_unread_idx')
      .on(t.userId)
      .where(sql`not ${t.isRead}`),
    index('notifications_outbox_idx')
      .on(t.emailState, t.createdAt)
      .where(sql`${t.emailState} in ('PENDING','BATCHED')`),
  ],
);

/**
 * Append-only audit log.
 *
 * Serves three purposes at once: the activity feed (FR-NOTIF-04), the ledger
 * audit trail (FR-NFR-SEC-12), and the data behind any future version history
 * (FR-UNDO-04). The application role holds no UPDATE or DELETE grant.
 */
export const activityEvents = pgTable(
  'activity_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    /** Dotted event name, e.g. 'expense.created', 'block.moved'. */
    kind: text('kind').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('activity_trip_idx').on(t.tripId, t.createdAt)],
);

export type InviteRow = typeof invites.$inferSelect;
export type ShareLinkRow = typeof shareLinks.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type SuggestionRow = typeof suggestions.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotificationRow = typeof notifications.$inferInsert;
export type ActivityEventRow = typeof activityEvents.$inferSelect;
export type NewActivityEventRow = typeof activityEvents.$inferInsert;
