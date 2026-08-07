/**
 * Collaboration contracts — members, invites, comments, suggestions.
 * FR-COLLAB-01…12, FR-SHARE-05/06.
 */

import { z } from 'zod';

import { CreateBlockBody } from './canvas';
import { IsoDateTime, MemberRole, Uuid } from './common';

// ── Members (FR-COLLAB-04/05/12) ────────────────────────────────────

export const MemberDTO = z.object({
  userId: Uuid,
  displayName: z.string(),
  email: z.string(),
  avatarTone: z.string(),
  role: MemberRole,
  /** The ledger identity, when they have one. */
  participantId: Uuid.nullable(),
  joinedAt: IsoDateTime,
  lastActiveAt: IsoDateTime.nullable(),
  /** Drives the presence ring — active in the last 5 minutes. */
  isLive: z.boolean(),
});

export const ChangeRoleBody = z.object({
  role: MemberRole,
});

export const TransferOwnershipBody = z.object({
  toUserId: Uuid,
});

// ── Invites (FR-COLLAB-02/03/10) ────────────────────────────────────

export const SendInvitesBody = z.object({
  /** The UI collects these as tags; the API takes the resolved list. */
  emails: z.array(z.string().email()).min(1).max(20),
  role: MemberRole.exclude(['OWNER']).default('EDITOR'),
  personalNote: z.string().trim().max(500).optional(),
  /** Optionally let the invitee claim an existing placeholder (FR-SPLIT-03). */
  claimsParticipantId: Uuid.nullish(),
});

export const InviteDTO = z.object({
  id: Uuid,
  tripId: Uuid,
  tripTitle: z.string(),
  email: z.string(),
  role: MemberRole,
  personalNote: z.string().nullable(),
  status: z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED']),
  inviterName: z.string(),
  expiresAt: IsoDateTime,
  sentAt: IsoDateTime,
});

/** The token arrives from the emailed link, never from a listing. */
export const AcceptInviteBody = z.object({
  token: z.string().min(10).max(200),
});

// ── Comments (FR-COLLAB-09, FR-SHARE-05) ────────────────────────────

export const CreateCommentBody = z.object({
  body: z.string().trim().min(1).max(2000),
  /** Null ⇒ a trip-level comment rather than one on a block. */
  blockId: Uuid.nullish(),
  /** One level of threading only — a reply cannot itself be replied to. */
  parentCommentId: Uuid.nullish(),
  mentionedUserIds: z.array(Uuid).max(20).default([]),
});

export const UpdateCommentBody = z.object({
  body: z.string().trim().min(1).max(2000),
});

export const CommentDTO = z.object({
  id: Uuid,
  tripId: Uuid,
  blockId: Uuid.nullable(),
  parentCommentId: Uuid.nullable(),
  authorId: Uuid.nullable(),
  authorName: z.string(),
  guestName: z.string().nullable(),
  body: z.string(),
  mentionedUserIds: z.array(Uuid),
  resolvedAt: IsoDateTime.nullable(),
  resolvedBy: Uuid.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ListCommentsQuery = z.object({
  blockId: Uuid.optional(),
  includeResolved: z.enum(['true', 'false']).default('false'),
});

// ── Suggestions (FR-COLLAB-08, FR-SHARE-06) ─────────────────────────

export const CreateSuggestionBody = z.object({
  dayId: Uuid.nullish(),
  /** Same shape as a block — accepting one materialises exactly this. */
  proposedBlock: CreateBlockBody,
  rationale: z.string().trim().max(500).optional(),
});

export const ReviewSuggestionBody = z.object({
  decision: z.enum(['ACCEPT', 'REJECT']),
  reason: z.string().trim().max(500).optional(),
  /** Required when accepting a suggestion that named no day. */
  dayId: Uuid.nullish(),
});

export const SuggestionDTO = z.object({
  id: Uuid,
  tripId: Uuid,
  dayId: Uuid.nullable(),
  proposedBlock: z.unknown(),
  rationale: z.string().nullable(),
  proposedBy: Uuid.nullable(),
  proposerName: z.string(),
  guestName: z.string().nullable(),
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN']),
  reviewedBy: Uuid.nullable(),
  reviewReason: z.string().nullable(),
  reviewedAt: IsoDateTime.nullable(),
  createdBlockId: Uuid.nullable(),
  createdAt: IsoDateTime,
});

export const ListSuggestionsQuery = z.object({
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN']).optional(),
});

export type SendInvitesBody = z.infer<typeof SendInvitesBody>;
export type CreateCommentBody = z.infer<typeof CreateCommentBody>;
export type CreateSuggestionBody = z.infer<typeof CreateSuggestionBody>;
export type ReviewSuggestionBody = z.infer<typeof ReviewSuggestionBody>;

// ── Sharing (FR-SHARE-*) ────────────────────────────────────────────

export const ShareSettingsBody = z.object({
  isEnabled: z.boolean().optional(),
  allowComments: z.boolean().optional(),
  allowSuggestions: z.boolean().optional(),
  /** Null clears the password; omitted leaves it unchanged. */
  password: z.string().min(4).max(128).nullish(),
  expiresAt: IsoDateTime.nullish(),
  variantId: Uuid.nullish(),
});

export const ShareLinkDTO = z.object({
  id: Uuid,
  tripId: Uuid,
  slug: z.string(),
  url: z.string(),
  isEnabled: z.boolean(),
  allowComments: z.boolean(),
  allowSuggestions: z.boolean(),
  hasPassword: z.boolean(),
  expiresAt: IsoDateTime.nullable(),
  variantId: Uuid.nullable(),
  viewCount: z.number().int(),
});

export const GuestCommentBody = z.object({
  guestName: z.string().trim().min(1).max(40),
  body: z.string().trim().min(1).max(2000),
  blockId: Uuid.nullish(),
});

// ── Exports (FR-EXP-*) ──────────────────────────────────────────────

export const ExportQuery = z.object({
  variantId: Uuid.optional(),
  includeCosts: z.enum(['true', 'false']).default('true'),
  /** Defaults to FALSE — booking data leaves the product in an export file. */
  includeBookings: z.enum(['true', 'false']).default('false'),
  includeNotes: z.enum(['true', 'false']).default('true'),
});

// ── Packing (FR-PANEL-06/07) ────────────────────────────────────────

export const AddPackingItemBody = z.object({
  category: z.string().trim().min(1).max(40).default('General'),
  label: z.string().trim().min(1).max(120),
});

export const UpdatePackingItemBody = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().min(1).max(40).optional(),
  isChecked: z.boolean().optional(),
});

export const PackingItemDTO = z.object({
  id: Uuid,
  category: z.string(),
  label: z.string(),
  isChecked: z.boolean(),
  checkedBy: Uuid.nullable(),
  checkedByName: z.string().nullable(),
  checkedAt: IsoDateTime.nullable(),
  sortOrder: z.number().int(),
});

export const PackingListResponse = z.object({
  items: z.array(PackingItemDTO),
  packedCount: z.number().int(),
  totalCount: z.number().int(),
});

/** FR-PANEL-08 — seed a starter list rather than starting from nothing. */
export const SeedPackingBody = z.object({
  replace: z.boolean().default(false),
});

// ── Trip notes (FR-PANEL-09/10) ─────────────────────────────────────

export const UpdateTripNotesBody = z.object({
  body: z.string().max(50_000),
  /** Optimistic lock: the notes are shared, so two people can collide. */
  version: z.number().int().positive(),
});

export const TripNotesDTO = z.object({
  tripId: Uuid,
  body: z.string(),
  version: z.number().int(),
  updatedBy: Uuid.nullable(),
  updatedByName: z.string().nullable(),
  updatedAt: IsoDateTime,
  wordCount: z.number().int(),
});

// ── Notifications (FR-NOTIF-01…08) ──────────────────────────────────

export const ListNotificationsQuery = z.object({
  unreadOnly: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const NotificationDTO = z.object({
  id: Uuid,
  tripId: Uuid.nullable(),
  tripTitle: z.string().nullable(),
  kind: z.string(),
  actorId: Uuid.nullable(),
  actorName: z.string().nullable(),
  body: z.string(),
  entityType: z.string().nullable(),
  entityId: Uuid.nullable(),
  isRead: z.boolean(),
  createdAt: IsoDateTime,
});

export const NotificationsResponse = z.object({
  items: z.array(NotificationDTO),
  unreadCount: z.number().int(),
});

export const ActivityEventDTO = z.object({
  id: z.string(),
  kind: z.string(),
  entityType: z.string(),
  entityId: Uuid.nullable(),
  actorId: Uuid.nullable(),
  actorName: z.string().nullable(),
  createdAt: IsoDateTime,
});

// ── Search (FR-SRCH-01/05/06/07) ────────────────────────────────────

export const SearchQuery = z.object({
  q: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const SearchResponse = z.object({
  trips: z.array(z.object({ id: Uuid, title: z.string(), destination: z.string(), rank: z.number() })),
  /** Deep-link targets so the client can scroll to and highlight the block. */
  blocks: z.array(
    z.object({
      id: Uuid,
      title: z.string(),
      meta: z.string(),
      tripId: Uuid,
      tripTitle: z.string(),
      variantId: Uuid,
      dayId: Uuid,
      dayNumber: z.number().int(),
      rank: z.number(),
    }),
  ),
  people: z.array(
    z.object({ participantId: Uuid, displayName: z.string(), tripId: Uuid, tripTitle: z.string() }),
  ),
});


// ── Image search (FR-MEDIA-*) ───────────────────────────────────────

export const ImageSearchQuery = z.object({
  q: z.string().trim().min(2).max(100),
  provider: z.string().max(40).optional(),
  page: z.coerce.number().int().min(1).max(50).default(1),
  perPage: z.coerce.number().int().min(1).max(40).default(20),
});

export const ProviderPhotoDTO = z.object({
  id: z.string(),
  description: z.string(),
  url: z.string(),
  thumbUrl: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  tone: z.string().nullable(),
  photographer: z.string(),
  photographerUrl: z.string(),
  sourceUrl: z.string(),
});

export const ImageSearchResponse = z.object({
  provider: z.string(),
  /** MUST be rendered alongside results — a licence obligation, not branding. */
  attributionLabel: z.string(),
  page: z.number().int(),
  totalPages: z.number().int(),
  photos: z.array(ProviderPhotoDTO),
});

export const AttachProviderImageBody = z.object({
  photoId: z.string().min(1).max(80),
  provider: z.string().max(40).optional(),
});

export const ImageSourcesResponse = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      attributionLabel: z.string(),
      attachMode: z.enum(['IMPORT', 'REFERENCE']),
    }),
  ),
});

// ── Places & maps (FR-TRIP-02, FR-SEC-04, FR-PANEL-04/05) ───────────

export const PlaceSearchQuery = z.object({
  q: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

export const PlaceDTO = z.object({
  placeId: z.string(),
  name: z.string(),
  address: z.string(),
  lat: z.number(),
  lng: z.number(),
  category: z.string().nullable(),
});

export const PlaceSearchResponse = z.object({
  provider: z.string(),
  items: z.array(PlaceDTO),
});

export const TripMapQuery = z.object({ variantId: Uuid.optional() });

export const MapPinDTO = z.object({
  blockId: Uuid,
  dayId: Uuid,
  /** Lets the client colour markers by day and draw a route line. */
  dayNumber: z.number().int(),
  blockType: z.string(),
  title: z.string(),
  name: z.string(),
  lat: z.number(),
  lng: z.number(),
});

export const TripMapResponse = z.object({
  provider: z.string(),
  pins: z.array(MapPinDTO),
  center: z.object({ lat: z.number(), lng: z.number() }).nullable(),
  /** Bounding box, so the client can fit the viewport without guessing zoom. */
  bounds: z
    .object({ north: z.number(), south: z.number(), east: z.number(), west: z.number() })
    .nullable(),
});
