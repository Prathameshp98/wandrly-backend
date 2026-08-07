/**
 * Media routes.
 *
 * Uploads are `application/octet-stream` with the raw bytes as the body: the
 * file type is determined from the CONTENT, so a multipart form part's declared
 * type would be ignored anyway. One less dependency, and no parser surface on
 * an authenticated endpoint.
 */

import { Router, raw } from 'express';
import { z } from 'zod';

import {
  AttachProviderImageBody,
  ImageSearchQuery,
} from '../../contracts/index';
import { limits } from '../../platform/config/env';
import { validate, validated } from '../../platform/http/validate';
import { NotFoundError } from '../../platform/errors/AppError';
import { mediaService } from './media.service';
import { imageSearchService } from './image-search.service';

export const mediaRouter = Router();

const MediaIdParam = z.object({ id: z.string().uuid() });
const AltTextBody = z.object({ altText: z.string().max(500).nullable() });

// ── Third-party image search (FR-MEDIA-*) ───────────────────────────
// Registered before `/media/:id` so the literal paths win.

mediaRouter.get('/media/sources', validate({}), async (_req, res) => {
  res.json({ items: imageSearchService.sources() });
});

mediaRouter.get(
  '/media/search',
  validate({ query: ImageSearchQuery }),
  async (req, res) => {
    const { q, provider, page, perPage } = validated.query(req, ImageSearchQuery);
    res.json(await imageSearchService.search(provider, q, page, perPage));
  },
);

mediaRouter.post(
  '/media/attach',
  validate({ body: AttachProviderImageBody }),
  async (req, res) => {
    const { photoId, provider } = validated.body(req, AttachProviderImageBody);
    res.status(201).json(await imageSearchService.attach(req.ctx.userId, provider, photoId));
  },
);

mediaRouter.get('/media/usage', validate({}), async (req, res) => {
  res.json(await mediaService.usage(req.ctx.userId));
});

mediaRouter.get('/media', validate({}), async (req, res) => {
  const assets = await mediaService.listForUser(req.ctx.userId);
  res.json({
    items: assets.map((asset) => ({
      id: asset.id,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
      byteSize: asset.byteSize,
      tone: asset.blurhash,
      altText: asset.altText,
      // Attribution travels with the asset: a Pexels image cannot legally be
      // displayed without it, so it is part of every representation.
      provider: asset.provider,
      attribution: asset.attribution,
      attributionUrl: asset.attributionUrl,
      remoteUrl: asset.remoteUrl,
      createdAt: asset.createdAt.toISOString(),
    })),
  });
});

mediaRouter.post(
  '/media',
  // Cap enforced by the parser as well as the service, so an oversized body is
  // rejected before it is fully buffered.
  raw({ type: '*/*', limit: limits.uploadBytes }),
  async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const altText = typeof req.query.altText === 'string' ? req.query.altText : undefined;
    res.status(201).json(await mediaService.upload(req.ctx.userId, body, { altText }));
  },
);

mediaRouter.patch(
  '/media/:id',
  validate({ params: MediaIdParam, body: AltTextBody }),
  async (req, res) => {
    const { id } = validated.params(req, MediaIdParam);
    const { altText } = validated.body(req, AltTextBody);
    const asset = await mediaService.setAltText(req.ctx.userId, id, altText);
    res.json({ id: asset.id, altText: asset.altText });
  },
);

mediaRouter.delete('/media/:id', validate({ params: MediaIdParam }), async (req, res) => {
  const { id } = validated.params(req, MediaIdParam);
  await mediaService.remove(req.ctx.userId, id);
  res.status(204).end();
});

/**
 * Serve the bytes.
 *
 * Restricted to the owner. Sharing an image with the crew happens by attaching
 * it to a block, and the block's own authorization governs that — this endpoint
 * is not the sharing mechanism.
 */
mediaRouter.get(
  '/media/:id/content',
  validate({ params: MediaIdParam }),
  async (req, res) => {
    const { id } = validated.params(req, MediaIdParam);
    const asset = await mediaService.findById(id);

    if (asset.ownerId !== req.ctx.userId) throw new NotFoundError('Media');

    const { body, mimeType } = await mediaService.content(id);
    res
      .type(mimeType)
      .set('Cache-Control', 'private, max-age=3600')
      .set('Content-Disposition', 'inline')
      // Never let a stored file be interpreted as something executable.
      .set('X-Content-Type-Options', 'nosniff')
      .send(body);
  },
);
