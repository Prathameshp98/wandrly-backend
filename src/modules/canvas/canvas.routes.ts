/**
 * Canvas routes.
 *
 * Days and blocks are addressed by their own id, so they resolve their trip by
 * walking up the ownership chain rather than taking a `:tripId` param. The
 * service re-verifies that chain — see the `require*` guards there.
 */

import { Router } from 'express';

import {
  CanvasQuery,
  CreateBlockBody,
  CreateDayBody,
  CreateVariantBody,
  IdParam,
  MoveBlockBody,
  ReorderBlocksBody,
  ReorderDaysBody,
  TripAndIdParam,
  TripIdParam,
  UpdateBlockBody,
  UpdateDayBody,
  UpdateVariantBody,
} from '../../contracts/index';
import { validate, validated } from '../../platform/http/validate';
import { idempotent } from '../../platform/http/idempotency';
import { accessOf, withTripAccess, withTripRead } from '../../platform/http/withTripAccess';
import { canvasService } from './canvas.service';
import { toBlockDTO, toCanvasDTO, toDayDTO, toVariantDTO } from './canvas.presenter';

export const canvasRouter = Router();

// ── Canvas read ─────────────────────────────────────────────────────

canvasRouter.get(
  '/trips/:tripId/canvas',
  validate({ params: TripIdParam, query: CanvasQuery }),
  withTripRead('trip:view'),
  async (req, res) => {
    const { variantId } = validated.query(req, CanvasQuery);
    const canvas = await canvasService.getCanvas(accessOf(req), variantId);
    res.json(toCanvasDTO(canvas));
  },
);

// ── Variants ────────────────────────────────────────────────────────

canvasRouter.get(
  '/trips/:tripId/variants',
  validate({ params: TripIdParam }),
  withTripRead('trip:view'),
  async (req, res) => {
    const items = await canvasService.listVariants(accessOf(req));
    res.json({ items: items.map(toVariantDTO) });
  },
);

canvasRouter.post(
  '/trips/:tripId/variants',
  validate({ params: TripIdParam, body: CreateVariantBody }),
  withTripAccess('variant:create'),
  idempotent(),
  async (req, res) => {
    const variant = await canvasService.createVariant(
      accessOf(req),
      validated.body(req, CreateVariantBody),
    );
    res.status(201).json(toVariantDTO(variant));
  },
);

canvasRouter.patch(
  '/trips/:tripId/variants/:id',
  validate({ params: TripAndIdParam, body: UpdateVariantBody }),
  withTripAccess('variant:create'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    const { name } = validated.body(req, UpdateVariantBody);
    res.json(toVariantDTO(await canvasService.renameVariant(accessOf(req), id, name)));
  },
);

canvasRouter.post(
  '/trips/:tripId/variants/:id/promote',
  validate({ params: TripAndIdParam }),
  withTripAccess('variant:promote'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    await canvasService.promoteVariant(accessOf(req), id);
    res.status(204).end();
  },
);

canvasRouter.delete(
  '/trips/:tripId/variants/:id',
  validate({ params: TripAndIdParam }),
  withTripAccess('variant:create'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    await canvasService.deleteVariant(accessOf(req), id);
    res.status(204).end();
  },
);

// ── Days ────────────────────────────────────────────────────────────

canvasRouter.post(
  '/trips/:tripId/variants/:id/days',
  validate({ params: TripAndIdParam, body: CreateDayBody }),
  withTripAccess('day:manage'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    const day = await canvasService.addDay(accessOf(req), id, validated.body(req, CreateDayBody));
    res.status(201).json(toDayDTO(day));
  },
);

canvasRouter.post(
  '/trips/:tripId/variants/:id/days/reorder',
  validate({ params: TripAndIdParam, body: ReorderDaysBody }),
  withTripAccess('day:manage'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    const { orderedDayIds } = validated.body(req, ReorderDaysBody);
    await canvasService.reorderDays(accessOf(req), id, orderedDayIds);
    res.status(204).end();
  },
);

canvasRouter.patch(
  '/trips/:tripId/days/:id',
  validate({ params: TripAndIdParam, body: UpdateDayBody }),
  withTripAccess('day:manage'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    const day = await canvasService.updateDay(
      accessOf(req),
      id,
      validated.body(req, UpdateDayBody),
    );
    res.json(toDayDTO(day));
  },
);

canvasRouter.delete(
  '/trips/:tripId/days/:id',
  validate({ params: TripAndIdParam }),
  withTripAccess('day:manage'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    await canvasService.deleteDay(accessOf(req), id);
    res.status(204).end();
  },
);

canvasRouter.post(
  '/trips/:tripId/days/:id/duplicate',
  validate({ params: TripAndIdParam }),
  withTripAccess('day:manage'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    const day = await canvasService.duplicateDay(accessOf(req), id);
    res.status(201).json(toDayDTO(day));
  },
);

canvasRouter.post(
  '/trips/:tripId/days/:id/blocks',
  validate({ params: TripAndIdParam, body: CreateBlockBody }),
  withTripAccess('block:create'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    const block = await canvasService.addBlock(
      accessOf(req),
      id,
      validated.body(req, CreateBlockBody),
    );
    res.status(201).json(toBlockDTO(block));
  },
);

canvasRouter.post(
  '/trips/:tripId/days/:id/blocks/reorder',
  validate({ params: TripAndIdParam, body: ReorderBlocksBody }),
  withTripAccess('block:create'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    const { orderedBlockIds } = validated.body(req, ReorderBlocksBody);
    await canvasService.reorderBlocks(accessOf(req), id, orderedBlockIds);
    res.status(204).end();
  },
);

// ── Blocks ──────────────────────────────────────────────────────────

canvasRouter.patch(
  '/trips/:tripId/blocks/:id',
  validate({ params: TripAndIdParam, body: UpdateBlockBody }),
  // 'block:create' is the coarse gate; the service then asserts
  // block:edit-any / -own against the block's actual author.
  withTripAccess('block:create'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    const block = await canvasService.updateBlock(
      accessOf(req),
      id,
      validated.body(req, UpdateBlockBody),
    );
    res.json(toBlockDTO(block));
  },
);

canvasRouter.delete(
  '/trips/:tripId/blocks/:id',
  validate({ params: TripAndIdParam }),
  withTripAccess('block:create'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    await canvasService.deleteBlock(accessOf(req), id);
    res.status(204).end();
  },
);

canvasRouter.post(
  '/trips/:tripId/blocks/:id/restore',
  validate({ params: TripAndIdParam }),
  withTripAccess('block:create'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    await canvasService.restoreBlock(accessOf(req), id);
    res.status(204).end();
  },
);

canvasRouter.post(
  '/trips/:tripId/blocks/:id/move',
  validate({ params: TripAndIdParam, body: MoveBlockBody }),
  withTripAccess('block:create'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    await canvasService.moveBlock(accessOf(req), id, validated.body(req, MoveBlockBody));
    res.status(204).end();
  },
);

void IdParam;
