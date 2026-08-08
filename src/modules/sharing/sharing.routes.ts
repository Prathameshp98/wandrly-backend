/**
 * Share-link management (authenticated) and the public page (not).
 *
 * `publicRouter` is mounted OUTSIDE `/v1` and outside `requireAuth`: a share
 * link must work for someone with no account, which is the entire point.
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  GuestCommentBody,
  ShareSettingsBody,
  TripIdParam,
} from '../../contracts/index';
import { validate, validated } from '../../platform/http/validate';
import { accessOf, withTripAccess, withTripRead } from '../../platform/http/withTripAccess';
import { ForbiddenError, NotFoundError } from '../../platform/errors/AppError';
import { sharingService } from './sharing.service';
import { renderPasswordPage, renderPublicPage } from './public-page';

export const sharingRouter = Router();

const toShareDTO = (link: {
  id: string; tripId: string; slug: string; isEnabled: boolean;
  allowComments: boolean; allowSuggestions: boolean; passwordHash: string | null;
  expiresAt: Date | null; variantId: string | null; viewCount: number;
}) => ({
  id: link.id,
  tripId: link.tripId,
  slug: link.slug,
  url: sharingService.publicUrlFor(link.slug),
  isEnabled: link.isEnabled,
  allowComments: link.allowComments,
  allowSuggestions: link.allowSuggestions,
  // The hash itself is never emitted.
  hasPassword: link.passwordHash !== null,
  expiresAt: link.expiresAt?.toISOString() ?? null,
  variantId: link.variantId,
  viewCount: link.viewCount,
});

sharingRouter.get(
  '/trips/:tripId/share',
  validate({ params: TripIdParam }),
  // Reading the link hands over the slug, which IS the capability to share the
  // trip with the world. PRD §8 restricts "Manage share link" to Owner and
  // Editor, and handing a Viewer the URL to paste elsewhere is that same act.
  withTripRead('share:manage'),
  async (req, res) => {
    const link = await sharingService.getLink(accessOf(req));
    res.json(link ? toShareDTO(link) : null);
  },
);

sharingRouter.put(
  '/trips/:tripId/share',
  validate({ params: TripIdParam, body: ShareSettingsBody }),
  withTripAccess('share:manage'),
  async (req, res) => {
    const link = await sharingService.upsertLink(
      accessOf(req),
      validated.body(req, ShareSettingsBody),
    );
    res.json(toShareDTO(link));
  },
);

sharingRouter.delete(
  '/trips/:tripId/share',
  validate({ params: TripIdParam }),
  withTripAccess('share:manage'),
  async (req, res) => {
    await sharingService.revokeLink(accessOf(req));
    res.status(204).end();
  },
);

// ── Public, unauthenticated ─────────────────────────────────────────

export const publicRouter = Router();

const SlugParam = z.object({ slug: z.string().min(10).max(64) });
const PasswordQuery = z.object({ password: z.string().max(128).optional() });

publicRouter.get(
  '/p/:slug',
  validate({ params: SlugParam, query: PasswordQuery }),
  async (req, res) => {
    const { slug } = validated.params(req, SlugParam);
    const { password } = validated.query(req, PasswordQuery);

    try {
      const [view, ownerName, comments] = await Promise.all([
        sharingService.resolve(slug, password),
        sharingService.ownerNameFor(slug),
        sharingService.publicComments(slug),
      ]);

      res
        .status(200)
        .type('html')
        // Short TTL: cheap for a link doing the rounds in a group chat, without
        // serving a stale itinerary for long.
        .set('Cache-Control', 'public, max-age=60')
        .send(
          renderPublicPage({
            view,
            ownerName,
            canonicalUrl: sharingService.publicUrlFor(slug),
            comments,
          }),
        );
    } catch (error) {
      if (error instanceof ForbiddenError) {
        res.status(401).type('html').send(renderPasswordPage(slug, Boolean(password)));
        return;
      }
      if (error instanceof NotFoundError) {
        res.status(404).type('html').send(
          '<!doctype html><meta charset="utf-8"><title>Not found</title>' +
            '<body style="font-family:system-ui;display:grid;place-items:center;' +
            'min-height:100vh;margin:0;background:#0A0B0E;color:#9AA0AA">' +
            '<p>This trip link is no longer available.</p></body>',
        );
        return;
      }
      throw error;
    }
  },
);

/** JSON view of the same data, for any client that wants to render its own. */
publicRouter.get(
  '/p/:slug/data',
  validate({ params: SlugParam, query: PasswordQuery }),
  async (req, res) => {
    const { slug } = validated.params(req, SlugParam);
    const { password } = validated.query(req, PasswordQuery);

    try {
      res.json(await sharingService.resolve(slug, password));
    } catch (error) {
      // The HTML twin answers 401 and offers the password form. Letting this
      // one fall through to the error handler made the same condition a 403,
      // which tells a client "never" where the truth is "supply the password".
      if (error instanceof ForbiddenError) {
        res.status(401).json({
          error: {
            code: 'PASSWORD_REQUIRED',
            message: 'This link is password protected.',
          },
        });
        return;
      }
      throw error;
    }
  },
);

publicRouter.post(
  '/p/:slug/comments',
  validate({ params: SlugParam, body: GuestCommentBody }),
  async (req, res) => {
    const { slug } = validated.params(req, SlugParam);
    const result = await sharingService.guestComment(slug, validated.body(req, GuestCommentBody));
    res.status(201).json(result);
  },
);

const GuestTokenQuery = z.object({ guestToken: z.string().min(10).max(200) });

publicRouter.delete(
  '/p/:slug/comments/:id',
  validate({ params: SlugParam.extend({ id: z.string().uuid() }), query: GuestTokenQuery }),
  async (req, res) => {
    const { slug, id } = validated.params(req, SlugParam.extend({ id: z.string().uuid() }));
    const { guestToken } = validated.query(req, GuestTokenQuery);
    await sharingService.deleteGuestComment(slug, id, guestToken);
    res.status(204).end();
  },
);
