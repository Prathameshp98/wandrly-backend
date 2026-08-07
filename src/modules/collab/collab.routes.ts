/**
 * Collaboration routes.
 *
 * Invite accept/decline sit OUTSIDE `withTripAccess` by necessity: the caller is
 * not a member yet, so the access loader would 404. The emailed token is the
 * authorization, and the service checks it was addressed to this user's email.
 */

import { Router } from 'express';

import {
  AcceptInviteBody,
  ChangeRoleBody,
  CreateCommentBody,
  CreateSuggestionBody,
  ListCommentsQuery,
  ListSuggestionsQuery,
  ReviewSuggestionBody,
  SendInvitesBody,
  TransferOwnershipBody,
  TripAndIdParam,
  TripIdParam,
  UpdateCommentBody,
} from '../../contracts/index';
import { z } from 'zod';
import { validate, validated } from '../../platform/http/validate';
import { idempotent } from '../../platform/http/idempotency';
import { accessOf, withTripAccess, withTripRead } from '../../platform/http/withTripAccess';
import { collabService } from './collab.service';
import {
  toCommentDTO,
  toInviteDTO,
  toMemberDTO,
  toSuggestionDTO,
} from './collab.presenter';

export const collabRouter = Router();

// ── Members ─────────────────────────────────────────────────────────

collabRouter.get(
  '/trips/:tripId/members',
  validate({ params: TripIdParam }),
  withTripRead('trip:view'),
  async (req, res) => {
    const members = await collabService.listMembers(accessOf(req));
    res.json({ items: members.map(toMemberDTO) });
  },
);

collabRouter.post(
  '/trips/:tripId/presence',
  validate({ params: TripIdParam }),
  withTripRead('trip:view'),
  async (req, res) => {
    await collabService.touchPresence(accessOf(req));
    res.status(204).end();
  },
);

const UserIdParam = TripIdParam.extend({ userId: z.string().uuid() });

collabRouter.patch(
  '/trips/:tripId/members/:userId',
  validate({ params: UserIdParam, body: ChangeRoleBody }),
  withTripAccess('member:manage'),
  async (req, res) => {
    const { userId } = validated.params(req, UserIdParam);
    const { role } = validated.body(req, ChangeRoleBody);
    await collabService.changeRole(accessOf(req), userId, role);
    res.status(204).end();
  },
);

collabRouter.delete(
  '/trips/:tripId/members/:userId',
  validate({ params: UserIdParam }),
  withTripAccess('member:manage'),
  async (req, res) => {
    const { userId } = validated.params(req, UserIdParam);
    await collabService.removeMember(accessOf(req), userId);
    res.status(204).end();
  },
);

collabRouter.post(
  '/trips/:tripId/transfer-ownership',
  validate({ params: TripIdParam, body: TransferOwnershipBody }),
  withTripAccess('trip:transfer-ownership'),
  async (req, res) => {
    const { toUserId } = validated.body(req, TransferOwnershipBody);
    await collabService.transferOwnership(accessOf(req), toUserId);
    res.status(204).end();
  },
);

// ── Invites ─────────────────────────────────────────────────────────

collabRouter.get(
  '/trips/:tripId/invites',
  validate({ params: TripIdParam }),
  withTripAccess('member:invite', { requireMutable: false }),
  async (req, res) => {
    const invites = await collabService.listTripInvites(accessOf(req));
    res.json({ items: invites.map((invite) => toInviteDTO(invite)) });
  },
);

collabRouter.post(
  '/trips/:tripId/invites',
  validate({ params: TripIdParam, body: SendInvitesBody }),
  withTripAccess('member:invite'),
  idempotent(),
  async (req, res) => {
    const sent = await collabService.sendInvites(
      accessOf(req),
      validated.body(req, SendInvitesBody),
    );
    res.status(201).json({ sent });
  },
);

collabRouter.delete(
  '/trips/:tripId/invites/:id',
  validate({ params: TripAndIdParam }),
  withTripAccess('member:invite'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    await collabService.revokeInvite(accessOf(req), id);
    res.status(204).end();
  },
);

/** The invitee's own view — not scoped to a trip they cannot yet see. */
export const inviteRouter = Router();

inviteRouter.get('/invites', validate({}), async (req, res) => {
  const rows = await collabService.listMyInvites(req.ctx.userId);
  res.json({
    items: rows.map((row) =>
      toInviteDTO(row.invite, { tripTitle: row.tripTitle, inviterName: row.inviterName }),
    ),
  });
});

inviteRouter.post('/invites/accept', validate({ body: AcceptInviteBody }), async (req, res) => {
  const { token } = validated.body(req, AcceptInviteBody);
  const result = await collabService.acceptInvite(req.ctx.userId, token);
  res.status(200).json(result);
});

inviteRouter.post('/invites/decline', validate({ body: AcceptInviteBody }), async (req, res) => {
  const { token } = validated.body(req, AcceptInviteBody);
  await collabService.declineInvite(req.ctx.userId, token);
  res.status(204).end();
});

// ── Comments ────────────────────────────────────────────────────────

collabRouter.get(
  '/trips/:tripId/comments',
  validate({ params: TripIdParam, query: ListCommentsQuery }),
  withTripRead('trip:view'),
  async (req, res) => {
    const query = validated.query(req, ListCommentsQuery);
    const rows = await collabService.listComments(accessOf(req), {
      blockId: query.blockId,
      includeResolved: query.includeResolved === 'true',
    });
    res.json({ items: rows.map(toCommentDTO) });
  },
);

collabRouter.post(
  '/trips/:tripId/comments',
  validate({ params: TripIdParam, body: CreateCommentBody }),
  withTripAccess('comment:create'),
  async (req, res) => {
    const comment = await collabService.createComment(
      accessOf(req),
      validated.body(req, CreateCommentBody),
    );
    res.status(201).json(toCommentDTO(comment));
  },
);

collabRouter.patch(
  '/trips/:tripId/comments/:id',
  validate({ params: TripAndIdParam, body: UpdateCommentBody }),
  withTripAccess('comment:create'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    const { body } = validated.body(req, UpdateCommentBody);
    res.json(toCommentDTO(await collabService.updateComment(accessOf(req), id, body)));
  },
);

const ResolveBody = z.object({ resolved: z.boolean() });

collabRouter.post(
  '/trips/:tripId/comments/:id/resolve',
  validate({ params: TripAndIdParam, body: ResolveBody }),
  withTripRead('trip:view'),
  async (req, res) => {
    // The fine-grained check (own vs any) happens in the service.
    const { id } = validated.params(req, TripAndIdParam);
    const { resolved } = validated.body(req, ResolveBody);
    res.json(toCommentDTO(await collabService.resolveComment(accessOf(req), id, resolved)));
  },
);

collabRouter.delete(
  '/trips/:tripId/comments/:id',
  validate({ params: TripAndIdParam }),
  withTripAccess('comment:create'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    await collabService.deleteComment(accessOf(req), id);
    res.status(204).end();
  },
);

// ── Suggestions ─────────────────────────────────────────────────────

collabRouter.get(
  '/trips/:tripId/suggestions',
  validate({ params: TripIdParam, query: ListSuggestionsQuery }),
  withTripRead('trip:view'),
  async (req, res) => {
    const { status } = validated.query(req, ListSuggestionsQuery);
    const rows = await collabService.listSuggestions(accessOf(req), status);
    res.json({ items: rows.map(toSuggestionDTO) });
  },
);

collabRouter.post(
  '/trips/:tripId/suggestions',
  validate({ params: TripIdParam, body: CreateSuggestionBody }),
  withTripAccess('suggestion:create'),
  async (req, res) => {
    const suggestion = await collabService.createSuggestion(
      accessOf(req),
      validated.body(req, CreateSuggestionBody),
    );
    res.status(201).json(toSuggestionDTO(suggestion));
  },
);

collabRouter.post(
  '/trips/:tripId/suggestions/:id/review',
  validate({ params: TripAndIdParam, body: ReviewSuggestionBody }),
  withTripAccess('suggestion:review'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    const suggestion = await collabService.reviewSuggestion(
      accessOf(req),
      id,
      validated.body(req, ReviewSuggestionBody),
    );
    res.json(toSuggestionDTO(suggestion));
  },
);

collabRouter.post(
  '/trips/:tripId/suggestions/:id/withdraw',
  validate({ params: TripAndIdParam }),
  withTripAccess('suggestion:create'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    await collabService.withdrawSuggestion(accessOf(req), id);
    res.status(204).end();
  },
);
