/**
 * Collaboration row → DTO mapping.
 *
 * Invite tokens are never emitted — they exist only in the emailed link. A
 * listing shows that an invite exists, not how to accept it.
 */

import type {
  CommentRow,
  InviteRow,
  SuggestionRow,
} from '../../platform/db/schema/index';

export function toMemberDTO(row: {
  userId: string;
  displayName: string;
  email: string;
  avatarTone: string;
  role: string;
  participantId: string | null;
  joinedAt: Date;
  lastActiveAt: Date | null;
  isLive: boolean;
}) {
  return {
    userId: row.userId,
    displayName: row.displayName,
    email: row.email,
    avatarTone: row.avatarTone,
    role: row.role,
    participantId: row.participantId,
    joinedAt: row.joinedAt.toISOString(),
    lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
    isLive: row.isLive,
  };
}

export function toInviteDTO(
  invite: InviteRow,
  extra: { tripTitle?: string; inviterName?: string } = {},
) {
  return {
    id: invite.id,
    tripId: invite.tripId,
    tripTitle: extra.tripTitle ?? '',
    email: invite.email,
    role: invite.role,
    personalNote: invite.personalNote,
    status: invite.status,
    inviterName: extra.inviterName ?? '',
    expiresAt: invite.expiresAt.toISOString(),
    sentAt: invite.sentAt.toISOString(),
    // tokenHash is deliberately absent.
  };
}

export function toCommentDTO(row: { comment: CommentRow; authorName: string }) {
  const { comment } = row;
  return {
    id: comment.id,
    tripId: comment.tripId,
    blockId: comment.blockId,
    parentCommentId: comment.parentCommentId,
    authorId: comment.authorId,
    authorName: row.authorName,
    guestName: comment.guestName,
    body: comment.body,
    mentionedUserIds: comment.mentionedUserIds ?? [],
    resolvedAt: comment.resolvedAt?.toISOString() ?? null,
    resolvedBy: comment.resolvedBy,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
  };
}

export function toSuggestionDTO(row: { suggestion: SuggestionRow; proposerName: string }) {
  const { suggestion } = row;
  return {
    id: suggestion.id,
    tripId: suggestion.tripId,
    dayId: suggestion.dayId,
    proposedBlock: suggestion.proposedBlock,
    rationale: suggestion.rationale,
    proposedBy: suggestion.proposedBy,
    proposerName: row.proposerName,
    guestName: suggestion.guestName,
    status: suggestion.status,
    reviewedBy: suggestion.reviewedBy,
    reviewReason: suggestion.reviewReason,
    reviewedAt: suggestion.reviewedAt?.toISOString() ?? null,
    createdBlockId: suggestion.createdBlockId,
    createdAt: suggestion.createdAt.toISOString(),
  };
}
