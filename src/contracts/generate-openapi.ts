/**
 * OpenAPI generation.
 *
 * TECHNICAL_DESIGN §8.2 — with the frontend undecided, this document IS the
 * API's public interface. It is generated on every build and committed, so a
 * contract change shows up as a diff in review rather than at integration time.
 *
 * `test/api/openapi-coverage.test.ts` walks the live Express router stack and
 * fails if any public route is missing here, so documentation cannot silently
 * fall behind the code — which it already did once, across three phases.
 *
 * `/internal/cron/*`, `/health`, and `/p/*` are excluded by design.
 */

import { writeFileSync } from 'node:fs';

import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z, type AnyZodObject, type ZodTypeAny } from 'zod';

import * as C from './index';

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

const bearerAuth = registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'Supabase access token. Stateless — no cookies, so no CSRF surface.',
});

const ErrorEnvelope = registry.register(
  'Error',
  z.object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
      requestId: z.string().optional(),
    }),
  }),
);

const json = (schema: ZodTypeAny) => ({ 'application/json': { schema } });

const ERRORS = {
  400: { description: 'Validation failed', content: json(ErrorEnvelope) },
  401: { description: 'Authentication required', content: json(ErrorEnvelope) },
  403: { description: 'Forbidden', content: json(ErrorEnvelope) },
  404: {
    description: 'Not found — also returned for resources you cannot see',
    content: json(ErrorEnvelope),
  },
  409: {
    description: 'Conflict — stale version, duplicate, or date-change strategy required',
    content: json(ErrorEnvelope),
  },
  422: { description: 'Domain or ledger rule violation', content: json(ErrorEnvelope) },
  429: { description: 'Rate limited', content: json(ErrorEnvelope) },
};

const TripId = z.object({ tripId: z.string().uuid() });
const TripAndId = TripId.extend({ id: z.string().uuid() });
const UserIdParam = TripId.extend({ userId: z.string().uuid() });
const IdOnly = z.object({ id: z.string().uuid() });
const Ok = z.object({}).passthrough();
const listOf = (item: ZodTypeAny = Ok) => z.object({ items: z.array(item) });

interface RouteSpec {
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  path: string;
  summary: string;
  tag: string;
  description?: string;
  /** OpenAPI models params and query as objects, so these are narrower. */
  params?: AnyZodObject;
  query?: AnyZodObject;
  body?: ZodTypeAny;
  ok?: ZodTypeAny;
  status?: number;
}

/** Compact registration — boilerplate lives here, not at sixty call sites. */
function route(spec: RouteSpec): void {
  const status = spec.status ?? (spec.method === 'post' ? 201 : 200);

  registry.registerPath({
    method: spec.method,
    path: spec.path,
    summary: spec.summary,
    ...(spec.description ? { description: spec.description } : {}),
    tags: [spec.tag],
    security: [{ [bearerAuth.name]: [] }],
    request: {
      ...(spec.params ? { params: spec.params } : {}),
      ...(spec.query ? { query: spec.query } : {}),
      ...(spec.body ? { body: { content: json(spec.body) } } : {}),
    },
    responses: {
      [status]:
        status === 204
          ? { description: 'No content' }
          : { description: 'Success', content: json(spec.ok ?? Ok) },
      ...ERRORS,
    },
  });
}

// ── Trips & folders ─────────────────────────────────────────────────

const T = 'Trips';
route({ method: 'get', path: '/v1/trips', tag: T, summary: 'List trips for a view', query: C.ListTripsQuery, ok: listOf(C.TripSummaryDTO), status: 200 });
route({ method: 'get', path: '/v1/trips/dashboard', tag: T, summary: 'Dashboard list plus aggregate stats', status: 200 });
route({ method: 'post', path: '/v1/trips', tag: T, summary: 'Create a trip', body: C.CreateTripBody, ok: C.TripSummaryDTO,
  description: 'Creates the trip, its main variant, owner membership, an owner ledger participant, and one day per date — all in one transaction. Send an `Idempotency-Key` header.' });
route({ method: 'get', path: '/v1/trips/{tripId}', tag: T, summary: 'Get one trip', params: TripId, ok: C.TripSummaryDTO, status: 200 });
route({ method: 'patch', path: '/v1/trips/{tripId}', tag: T, summary: 'Update a trip', params: TripId, body: C.UpdateTripBody, ok: C.TripSummaryDTO, status: 200,
  description: 'Changing dates on a trip that already has days returns 409 with both day counts unless `dateChangeStrategy` is supplied. The server never guesses.' });
route({ method: 'delete', path: '/v1/trips/{tripId}', tag: T, summary: 'Soft-delete a trip (owner only)', params: TripId, status: 204 });
route({ method: 'post', path: '/v1/trips/{tripId}/restore', tag: T, summary: 'Restore a soft-deleted trip', params: TripId, status: 204 });
route({ method: 'post', path: '/v1/trips/{tripId}/archive', tag: T, summary: 'Archive a trip', params: TripId, status: 204 });
route({ method: 'post', path: '/v1/trips/{tripId}/unarchive', tag: T, summary: 'Unarchive a trip', params: TripId, status: 204 });
route({ method: 'post', path: '/v1/trips/{tripId}/pin', tag: T, summary: 'Pin or unpin (per-user)', params: TripId, body: z.object({ pinned: z.boolean() }), status: 204,
  description: 'Pinning is per-user: one member pinning does not reorder anyone else’s dashboard.' });
route({ method: 'post', path: '/v1/trips/{tripId}/duplicate', tag: T, summary: 'Duplicate a trip', params: TripId, ok: C.TripSummaryDTO,
  description: 'Deep-copies the itinerary. Never copies members, comments, share links, or the expense ledger.' });
route({ method: 'patch', path: '/v1/trips/{tripId}/folder', tag: T, summary: 'Move a trip between folders', params: TripId, body: C.MoveTripBody, status: 204 });
route({ method: 'post', path: '/v1/trips/reorder', tag: T, summary: 'Reorder trips (per-user)', body: C.ReorderTripsBody, status: 204 });

const F = 'Folders';
route({ method: 'get', path: '/v1/folders', tag: F, summary: 'List folders with live trip counts', ok: listOf(C.FolderDTO), status: 200 });
route({ method: 'post', path: '/v1/folders', tag: F, summary: 'Create a folder', body: C.CreateFolderBody, ok: C.FolderDTO });
route({ method: 'patch', path: '/v1/folders/{id}', tag: F, summary: 'Update a folder', params: IdOnly, body: C.UpdateFolderBody, ok: C.FolderDTO, status: 200 });
route({ method: 'delete', path: '/v1/folders/{id}', tag: F, summary: 'Delete a folder', params: IdOnly, status: 200,
  description: 'Trips are unfiled, never deleted. The response reports how many were affected.' });

// ── Canvas ──────────────────────────────────────────────────────────

const CV = 'Canvas';
route({ method: 'get', path: '/v1/trips/{tripId}/canvas', tag: CV, summary: 'Full canvas for a variant', params: TripId, query: C.CanvasQuery, ok: C.CanvasDTO, status: 200 });
route({ method: 'get', path: '/v1/trips/{tripId}/variants', tag: CV, summary: 'List variants', params: TripId, ok: listOf(C.VariantDTO), status: 200 });
route({ method: 'post', path: '/v1/trips/{tripId}/variants', tag: CV, summary: 'Create or fork a variant', params: TripId, body: C.CreateVariantBody, ok: C.VariantDTO,
  description: 'With `forkFromVariantId`, deep-copies days, blocks, and sections. The fork then diverges independently — editing it never touches the source.' });
route({ method: 'patch', path: '/v1/trips/{tripId}/variants/{id}', tag: CV, summary: 'Rename a variant', params: TripAndId, body: C.UpdateVariantBody, ok: C.VariantDTO, status: 200 });
route({ method: 'post', path: '/v1/trips/{tripId}/variants/{id}/promote', tag: CV, summary: 'Promote a variant to main (owner only)', params: TripAndId, status: 204,
  description: 'The previous main is retained as an ordinary variant, never deleted.' });
route({ method: 'delete', path: '/v1/trips/{tripId}/variants/{id}', tag: CV, summary: 'Delete a variant', params: TripAndId, status: 204 });

route({ method: 'post', path: '/v1/trips/{tripId}/variants/{id}/days', tag: CV, summary: 'Append a day', params: TripAndId, body: C.CreateDayBody, ok: C.DayDTO });
route({ method: 'post', path: '/v1/trips/{tripId}/variants/{id}/days/reorder', tag: CV, summary: 'Reorder days', params: TripAndId, body: C.ReorderDaysBody, status: 204 });
route({ method: 'patch', path: '/v1/trips/{tripId}/days/{id}', tag: CV, summary: 'Update a day', params: TripAndId, body: C.UpdateDayBody, ok: C.DayDTO, status: 200 });
route({ method: 'delete', path: '/v1/trips/{tripId}/days/{id}', tag: CV, summary: 'Delete a day', params: TripAndId, status: 204,
  description: 'Remaining days renumber contiguously.' });
route({ method: 'post', path: '/v1/trips/{tripId}/days/{id}/duplicate', tag: CV, summary: 'Duplicate a day', params: TripAndId, ok: C.DayDTO,
  description: 'The copy is inserted immediately AFTER the source, not at the end — an itinerary is chronological.' });

route({ method: 'post', path: '/v1/trips/{tripId}/days/{id}/blocks', tag: CV, summary: 'Add a block', params: TripAndId, body: C.CreateBlockBody, ok: C.BlockDTO });
route({ method: 'post', path: '/v1/trips/{tripId}/days/{id}/blocks/reorder', tag: CV, summary: 'Reorder blocks within a day', params: TripAndId, body: C.ReorderBlocksBody, status: 204 });
route({ method: 'patch', path: '/v1/trips/{tripId}/blocks/{id}', tag: CV, summary: 'Update a block', params: TripAndId, body: C.UpdateBlockBody, ok: C.BlockDTO, status: 200,
  description: 'Contributors may only edit blocks they created. Booking sections are encrypted at rest and returned decrypted to authorized callers.' });
route({ method: 'delete', path: '/v1/trips/{tripId}/blocks/{id}', tag: CV, summary: 'Soft-delete a block', params: TripAndId, status: 204 });
route({ method: 'post', path: '/v1/trips/{tripId}/blocks/{id}/restore', tag: CV, summary: 'Restore a deleted block', params: TripAndId, status: 204 });
route({ method: 'post', path: '/v1/trips/{tripId}/blocks/{id}/move', tag: CV, summary: 'Move a block to a day and position', params: TripAndId, body: C.MoveBlockBody, status: 204 });

// ── Collaboration ───────────────────────────────────────────────────

const CO = 'Collaboration';
route({ method: 'get', path: '/v1/trips/{tripId}/members', tag: CO, summary: 'List the crew', params: TripId, ok: listOf(C.MemberDTO), status: 200 });
route({ method: 'post', path: '/v1/trips/{tripId}/presence', tag: CO, summary: 'Presence heartbeat', params: TripId, status: 204 });
route({ method: 'patch', path: '/v1/trips/{tripId}/members/{userId}', tag: CO, summary: 'Change a member’s role (owner only)', params: UserIdParam, body: C.ChangeRoleBody, status: 204 });
route({ method: 'delete', path: '/v1/trips/{tripId}/members/{userId}', tag: CO, summary: 'Remove a member', params: UserIdParam, status: 204,
  description: 'Removes them from the crew but NOT from the expense ledger — they may still owe money.' });
route({ method: 'post', path: '/v1/trips/{tripId}/transfer-ownership', tag: CO, summary: 'Transfer ownership', params: TripId, body: C.TransferOwnershipBody, status: 204 });

route({ method: 'get', path: '/v1/trips/{tripId}/invites', tag: CO, summary: 'List pending invites', params: TripId, ok: listOf(C.InviteDTO), status: 200 });
route({ method: 'post', path: '/v1/trips/{tripId}/invites', tag: CO, summary: 'Send invites', params: TripId, body: C.SendInvitesBody,
  description: 'Tokens are emailed and stored hashed — they never appear in any response.' });
route({ method: 'delete', path: '/v1/trips/{tripId}/invites/{id}', tag: CO, summary: 'Revoke an invite', params: TripAndId, status: 204 });
route({ method: 'get', path: '/v1/invites', tag: CO, summary: 'Invites addressed to you', ok: listOf(C.InviteDTO), status: 200 });
route({ method: 'post', path: '/v1/invites/accept', tag: CO, summary: 'Accept an invite by token', body: C.AcceptInviteBody, status: 200,
  description: 'The only authenticated route outside trip-access control, because the caller is not a member yet. The token must match the invite’s email address.' });
route({ method: 'post', path: '/v1/invites/decline', tag: CO, summary: 'Decline an invite by token', body: C.AcceptInviteBody, status: 204 });

route({ method: 'get', path: '/v1/trips/{tripId}/comments', tag: CO, summary: 'List comments', params: TripId, query: C.ListCommentsQuery, ok: listOf(C.CommentDTO), status: 200 });
route({ method: 'post', path: '/v1/trips/{tripId}/comments', tag: CO, summary: 'Add a comment', params: TripId, body: C.CreateCommentBody, ok: C.CommentDTO });
route({ method: 'patch', path: '/v1/trips/{tripId}/comments/{id}', tag: CO, summary: 'Edit your own comment', params: TripAndId, body: C.UpdateCommentBody, ok: C.CommentDTO, status: 200 });
route({ method: 'post', path: '/v1/trips/{tripId}/comments/{id}/resolve', tag: CO, summary: 'Resolve or unresolve a thread', params: TripAndId, body: z.object({ resolved: z.boolean() }), ok: C.CommentDTO, status: 200 });
route({ method: 'delete', path: '/v1/trips/{tripId}/comments/{id}', tag: CO, summary: 'Delete a comment', params: TripAndId, status: 204 });

route({ method: 'get', path: '/v1/trips/{tripId}/suggestions', tag: CO, summary: 'Suggestion review queue', params: TripId, query: C.ListSuggestionsQuery, ok: listOf(C.SuggestionDTO), status: 200 });
route({ method: 'post', path: '/v1/trips/{tripId}/suggestions', tag: CO, summary: 'Propose a block', params: TripId, body: C.CreateSuggestionBody, ok: C.SuggestionDTO });
route({ method: 'post', path: '/v1/trips/{tripId}/suggestions/{id}/review', tag: CO, summary: 'Accept or reject a suggestion', params: TripAndId, body: C.ReviewSuggestionBody, ok: C.SuggestionDTO, status: 200,
  description: 'Accepting materialises a real block, attributed to the proposer rather than the reviewer.' });
route({ method: 'post', path: '/v1/trips/{tripId}/suggestions/{id}/withdraw', tag: CO, summary: 'Withdraw your own suggestion', params: TripAndId, status: 204 });

// ── Sharing ─────────────────────────────────────────────────────────

const S = 'Sharing';
route({ method: 'get', path: '/v1/trips/{tripId}/share', tag: S, summary: 'Get the share link', params: TripId, status: 200 });
route({ method: 'put', path: '/v1/trips/{tripId}/share', tag: S, summary: 'Create or update the share link', params: TripId, body: C.ShareSettingsBody, ok: C.ShareLinkDTO, status: 200,
  description: 'One link per trip. The public page at `/p/{slug}` is server-rendered HTML and deliberately not part of this API surface.' });
route({ method: 'delete', path: '/v1/trips/{tripId}/share', tag: S, summary: 'Revoke the share link', params: TripId, status: 204 });

// ── Exports ─────────────────────────────────────────────────────────

const E = 'Exports';
route({ method: 'get', path: '/v1/trips/{tripId}/export.txt', tag: E, summary: 'Plain-text itinerary', params: TripId, query: C.ExportQuery, status: 200,
  description: 'Booking details are excluded unless `includeBookings=true`.' });
route({ method: 'get', path: '/v1/trips/{tripId}/export.ics', tag: E, summary: 'Calendar file (RFC 5545)', params: TripId, query: C.ExportQuery, status: 200 });
route({ method: 'get', path: '/v1/trips/{tripId}/export.pdf', tag: E, summary: 'PDF itinerary', params: TripId, query: C.ExportQuery, status: 200 });
route({ method: 'get', path: '/v1/trips/{tripId}/expenses/export.csv', tag: E, summary: 'Expense report (one row per share)', params: TripId, status: 200 });

// ── Ledger ──────────────────────────────────────────────────────────

const L = 'Ledger';
route({ method: 'get', path: '/v1/trips/{tripId}/participants', tag: L, summary: 'List ledger participants', params: TripId, ok: listOf(C.ParticipantDTO), status: 200,
  description: 'Participants are the ledger’s identity and may have no account at all — which is what lets a group split with someone who will never sign up.' });
route({ method: 'post', path: '/v1/trips/{tripId}/participants', tag: L, summary: 'Add a placeholder participant', params: TripId, body: C.AddParticipantBody, ok: C.ParticipantDTO });
route({ method: 'patch', path: '/v1/trips/{tripId}/participants/{id}', tag: L, summary: 'Update a participant', params: TripAndId, body: C.UpdateParticipantBody, ok: C.ParticipantDTO, status: 200,
  description: 'Payout identifiers are encrypted at rest and never returned — responses expose only `hasPayoutDetails`.' });
route({ method: 'delete', path: '/v1/trips/{tripId}/participants/{id}', tag: L, summary: 'Remove a participant', params: TripAndId, status: 204,
  description: 'Someone with ledger history is never hard-deleted; removal needs a zero balance or an explicit `reassignToParticipantId`.' });

route({ method: 'get', path: '/v1/trips/{tripId}/expenses', tag: L, summary: 'List expenses', params: TripId, query: C.ListExpensesQuery, status: 200,
  description: 'A Viewer sees only expenses they are part of — filtered in SQL, not hidden client-side.' });
route({ method: 'post', path: '/v1/trips/{tripId}/expenses', tag: L, summary: 'Record an expense', params: TripId, body: C.CreateExpenseBody,
  description: 'The FX rate is frozen at creation, and shares are allocated in BOTH the expense currency and the trip base currency so each sums exactly. Send an `Idempotency-Key`.' });
route({ method: 'delete', path: '/v1/trips/{tripId}/expenses/{id}', tag: L, summary: 'Delete an expense (soft, undoable)', params: TripAndId, status: 204 });
route({ method: 'post', path: '/v1/trips/{tripId}/expenses/{id}/restore', tag: L, summary: 'Restore a deleted expense', params: TripAndId, status: 204 });

route({ method: 'get', path: '/v1/trips/{tripId}/balances', tag: L, summary: 'Net balance per participant', params: TripId, ok: C.BalancesResponse, status: 200,
  description: '`netMinor > 0` means the participant is owed money. The sum across all participants is always exactly zero.' });
route({ method: 'get', path: '/v1/trips/{tripId}/settle-up', tag: L, summary: 'Suggested transfers to clear all balances', params: TripId, query: C.SettleUpQuery, ok: C.SettleUpResponse, status: 200,
  description: 'Simplified mode gives the minimum transfer set (at most n−1), with a UPI deep link where the payee has saved details. Wandrly never moves money.' });
route({ method: 'get', path: '/v1/trips/{tripId}/settlements', tag: L, summary: 'Settlement history', params: TripId, ok: listOf(C.SettlementDTO), status: 200 });
route({ method: 'post', path: '/v1/trips/{tripId}/settlements', tag: L, summary: 'Record a settlement made outside Wandrly', params: TripId, body: C.RecordSettlementBody });
route({ method: 'post', path: '/v1/trips/{tripId}/settlements/{id}/confirm', tag: L, summary: 'Confirm receipt (payee only)', params: TripAndId, status: 200 });
route({ method: 'post', path: '/v1/trips/{tripId}/settlements/{id}/void', tag: L, summary: 'Void a settlement', params: TripAndId, body: C.VoidSettlementBody, status: 200 });
route({ method: 'get', path: '/v1/me/balances', tag: L, summary: 'Cross-trip balance summary', status: 200,
  description: 'The dashboard hook that brings users back after a trip ends.' });

// ── Panels: packing & notes ─────────────────────────────────────────

const P = 'Panels';
route({ method: 'get', path: '/v1/trips/{tripId}/packing', tag: P, summary: 'Shared packing list', params: TripId, ok: C.PackingListResponse, status: 200,
  description: 'Trip-scoped and collaborative, with per-item attribution of who packed it.' });
route({ method: 'post', path: '/v1/trips/{tripId}/packing', tag: P, summary: 'Add a packing item', params: TripId, body: C.AddPackingItemBody, ok: C.PackingItemDTO });
route({ method: 'post', path: '/v1/trips/{tripId}/packing/seed', tag: P, summary: 'Seed a starter list', params: TripId, body: C.SeedPackingBody, ok: C.PackingListResponse, status: 200,
  description: 'Non-destructive unless `replace` is set — seeding over an in-progress list would be rude.' });
route({ method: 'patch', path: '/v1/trips/{tripId}/packing/{id}', tag: P, summary: 'Update or check off an item', params: TripAndId, body: C.UpdatePackingItemBody, ok: C.PackingItemDTO, status: 200 });
route({ method: 'delete', path: '/v1/trips/{tripId}/packing/{id}', tag: P, summary: 'Delete a packing item', params: TripAndId, status: 204 });

route({ method: 'get', path: '/v1/trips/{tripId}/notes', tag: P, summary: 'Shared trip notes', params: TripId, ok: C.TripNotesDTO, status: 200 });
route({ method: 'put', path: '/v1/trips/{tripId}/notes', tag: P, summary: 'Update trip notes', params: TripId, body: C.UpdateTripNotesBody, ok: C.TripNotesDTO, status: 200,
  description: 'Optimistically locked: the notes are shared, so two people editing at once is expected, not an edge case.' });

// ── Notifications ───────────────────────────────────────────────────

const N = 'Notifications';
route({ method: 'get', path: '/v1/notifications', tag: N, summary: 'Your notifications and unread count', query: C.ListNotificationsQuery, ok: C.NotificationsResponse, status: 200 });
route({ method: 'post', path: '/v1/notifications/read', tag: N, summary: 'Mark all read', status: 204 });
route({ method: 'post', path: '/v1/notifications/{id}/read', tag: N, summary: 'Mark one read', params: IdOnly, status: 204 });
route({ method: 'get', path: '/v1/trips/{tripId}/activity', tag: N, summary: 'Trip activity feed', params: TripId, ok: listOf(C.ActivityEventDTO), status: 200 });

// ── Search ──────────────────────────────────────────────────────────

route({ method: 'get', path: '/v1/search', tag: 'Search', summary: 'Search trips, blocks, and people', query: C.SearchQuery, ok: C.SearchResponse, status: 200,
  description: 'Scoped by membership before ranking, so it is never an existence oracle. Block hits carry variant/day ids for deep-linking.' });

// ── Media ───────────────────────────────────────────────────────────

const M = 'Media';
route({ method: 'get', path: '/v1/media', tag: M, summary: 'List your uploads', status: 200 });
route({ method: 'get', path: '/v1/media/usage', tag: M, summary: 'Storage usage against your quota', status: 200 });
route({ method: 'post', path: '/v1/media', tag: M, summary: 'Upload an image',
  description: 'Send the raw bytes as `application/octet-stream`. The file type is decided by MAGIC BYTES, not the declared Content-Type, and EXIF is stripped before anything is persisted — so GPS from a photo never reaches storage. JPEG, PNG, WebP, HEIC.' });
route({ method: 'patch', path: '/v1/media/{id}', tag: M, summary: 'Set alt text', params: IdOnly, body: z.object({ altText: z.string().max(500).nullable() }), status: 200 });
route({ method: 'delete', path: '/v1/media/{id}', tag: M, summary: 'Delete an upload', params: IdOnly, status: 204 });
route({ method: 'get', path: '/v1/media/sources', tag: M, summary: 'Configured image sources', ok: C.ImageSourcesResponse, status: 200,
  description: 'Each source declares an `attachMode`: IMPORT self-hosts the bytes, REFERENCE embeds the provider CDN because their terms forbid caching.' });
route({ method: 'get', path: '/v1/media/search', tag: M, summary: 'Search third-party travel imagery', query: C.ImageSearchQuery, ok: C.ImageSearchResponse, status: 200,
  description: 'Backed by Pexels. `attributionLabel` and each photo’s photographer link MUST be rendered — attribution is a licence obligation, not branding. Results are cached for an hour so a search-as-you-type field cannot exhaust the 200/hour budget.' });
route({ method: 'post', path: '/v1/media/attach', tag: M, summary: 'Attach a provider photo to your library', body: C.AttachProviderImageBody,
  description: 'Idempotent per user and photo. In IMPORT mode the bytes are downloaded, re-validated by magic bytes (a provider is still an untrusted source), and stored. Attribution is copied onto the asset and travels with it.' });
route({ method: 'get', path: '/v1/media/{id}/content', tag: M, summary: 'Fetch the bytes (owner only)', params: IdOnly, status: 200,
  description: 'Sharing an image with the crew happens by attaching it to a block; the block’s own authorization governs that. This endpoint is not the sharing mechanism.' });

// ── Places & maps ───────────────────────────────────────────────────

const PL = 'Places';
route({ method: 'get', path: '/v1/places/search', tag: PL, summary: 'Search places for a location picker', query: C.PlaceSearchQuery, ok: C.PlaceSearchResponse, status: 200,
  description: 'Defaults to OpenStreetMap/Nominatim, which needs no API key and no billing account. Google Maps is used instead when the server has a key. Results are cached for a week — place coordinates do not move, and both providers require caching.' });
route({ method: 'get', path: '/v1/trips/{tripId}/map', tag: PL, summary: 'All located blocks as map pins', params: TripId, query: C.TripMapQuery, ok: C.TripMapResponse, status: 200,
  description: 'Every block carrying a location, with its day number so markers can be coloured by day and joined into a route. Includes a centre and bounding box so the client can fit the viewport. Rendering is the client’s job — free OSM tiles with MapLibre or Leaflet need no key.' });

export function buildOpenApiDocument() {
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'Wandrly API',
      version: '0.1.0',
      description: [
        'Collaborative trip planning with a group expense ledger.',
        '',
        '**Money on the wire.** Every monetary value is an integer in the',
        "currency's minor units, encoded as a STRING (`\"580000\"` = ₹5,800.00).",
        'JSON has no bigint and `Number` loses precision above 2^53, so amounts',
        'are never sent as numbers. Zero-decimal currencies (JPY, KRW) and',
        'three-decimal currencies (BHD, KWD) are handled correctly.',
        '',
        '**Authorization** is enforced server-side on every request against a',
        'four-role matrix. `404` is returned for resources you cannot see, so the',
        'API is never an existence oracle.',
        '',
        '**Not documented here:** `/p/{slug}` (server-rendered public pages),',
        '`/unsubscribe/{token}`, `/health`, and `/internal/cron/*`.',
      ].join('\n'),
    },
    servers: [{ url: '/', description: 'Current host' }],
    tags: [
      { name: 'Trips', description: 'Trip lifecycle and the dashboard' },
      { name: 'Folders', description: 'Grouping trips' },
      { name: 'Canvas', description: 'Variants, days, blocks, and rich sections' },
      { name: 'Collaboration', description: 'Members, invites, comments, suggestions' },
      { name: 'Sharing', description: 'Public read-only links' },
      { name: 'Exports', description: 'PDF, text, calendar, and CSV' },
      { name: 'Ledger', description: 'Participants, expenses, balances, settlement' },
      { name: 'Panels', description: 'Packing list and shared trip notes' },
      { name: 'Notifications', description: 'Notifications and the activity feed' },
      { name: 'Search', description: 'Full-text search across your trips' },
      { name: 'Media', description: 'Image uploads and third-party image search' },
      { name: 'Places', description: 'Place search, geocoding, and trip maps' },
    ],
  });
}

if (require.main === module) {
  writeFileSync('openapi.json', `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
  process.stdout.write('openapi.json written\n');
}
