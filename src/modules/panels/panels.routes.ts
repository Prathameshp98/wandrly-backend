/** Packing list, trip notes, and search routes. */

import { Router } from 'express';
import { z } from 'zod';

import {
  AddPackingItemBody,
  SearchQuery,
  SeedPackingBody,
  TripAndIdParam,
  TripIdParam,
  UpdatePackingItemBody,
  UpdateTripNotesBody,
} from '../../contracts/index';
import { validate, validated } from '../../platform/http/validate';
import { accessOf, withTripAccess, withTripRead } from '../../platform/http/withTripAccess';
import { panelsService } from './panels.service';
import { searchService } from '../search/search.service';

export const panelsRouter = Router();

const toItemDTO = (row: {
  item: {
    id: string; category: string; label: string; isChecked: boolean;
    checkedBy: string | null; checkedAt: Date | null; sortOrder: number;
  };
  checkedByName: string | null;
}) => ({
  id: row.item.id,
  category: row.item.category,
  label: row.item.label,
  isChecked: row.item.isChecked,
  checkedBy: row.item.checkedBy,
  checkedByName: row.checkedByName,
  checkedAt: row.item.checkedAt?.toISOString() ?? null,
  sortOrder: row.item.sortOrder,
});

// ── Packing ─────────────────────────────────────────────────────────

panelsRouter.get(
  '/trips/:tripId/packing',
  validate({ params: TripIdParam }),
  withTripRead('trip:view'),
  async (req, res) => {
    const result = await panelsService.listPacking(accessOf(req));
    res.json({
      items: result.items.map(toItemDTO),
      packedCount: result.packedCount,
      totalCount: result.totalCount,
    });
  },
);

panelsRouter.post(
  '/trips/:tripId/packing',
  validate({ params: TripIdParam, body: AddPackingItemBody }),
  withTripAccess('packing:edit'),
  async (req, res) => {
    const item = await panelsService.addPackingItem(
      accessOf(req),
      validated.body(req, AddPackingItemBody),
    );
    res.status(201).json(toItemDTO({ item, checkedByName: null }));
  },
);

panelsRouter.post(
  '/trips/:tripId/packing/seed',
  validate({ params: TripIdParam, body: SeedPackingBody }),
  withTripAccess('packing:edit'),
  async (req, res) => {
    const { replace } = validated.body(req, SeedPackingBody);
    const result = await panelsService.seedPacking(accessOf(req), replace);
    res.json({
      items: result.items.map(toItemDTO),
      packedCount: result.packedCount,
      totalCount: result.totalCount,
    });
  },
);

panelsRouter.patch(
  '/trips/:tripId/packing/:id',
  validate({ params: TripAndIdParam, body: UpdatePackingItemBody }),
  withTripAccess('packing:edit'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    const item = await panelsService.updatePackingItem(
      accessOf(req),
      id,
      validated.body(req, UpdatePackingItemBody),
    );
    res.json(toItemDTO({ item, checkedByName: null }));
  },
);

panelsRouter.delete(
  '/trips/:tripId/packing/:id',
  validate({ params: TripAndIdParam }),
  withTripAccess('packing:edit'),
  async (req, res) => {
    const { id } = validated.params(req, TripAndIdParam);
    await panelsService.deletePackingItem(accessOf(req), id);
    res.status(204).end();
  },
);

// ── Trip notes ──────────────────────────────────────────────────────

const wordCount = (body: string): number => body.split(/\s+/).filter(Boolean).length;

const toNotesDTO = (row: {
  note: { tripId: string; body: string; version: number; updatedBy: string | null; updatedAt: Date };
  updatedByName: string | null;
}) => ({
  tripId: row.note.tripId,
  body: row.note.body,
  version: row.note.version,
  updatedBy: row.note.updatedBy,
  updatedByName: row.updatedByName,
  updatedAt: row.note.updatedAt.toISOString(),
  wordCount: wordCount(row.note.body),
});

panelsRouter.get(
  '/trips/:tripId/notes',
  validate({ params: TripIdParam }),
  withTripRead('trip:view'),
  async (req, res) => {
    res.json(toNotesDTO(await panelsService.getNotes(accessOf(req))));
  },
);

panelsRouter.put(
  '/trips/:tripId/notes',
  validate({ params: TripIdParam, body: UpdateTripNotesBody }),
  withTripAccess('notes:edit'),
  async (req, res) => {
    const { body, version } = validated.body(req, UpdateTripNotesBody);
    res.json(toNotesDTO(await panelsService.updateNotes(accessOf(req), body, version)));
  },
);

// ── Search ──────────────────────────────────────────────────────────

export const searchRouter = Router();

searchRouter.get('/search', validate({ query: SearchQuery }), async (req, res) => {
  const { q, limit } = validated.query(req, SearchQuery);
  res.json(await searchService.search(req.ctx.userId, q, limit));
});

void z;
