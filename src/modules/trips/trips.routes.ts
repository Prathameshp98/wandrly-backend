/**
 * Trip and folder routes.
 *
 * Handlers stay three lines: delegate, serialise, respond.
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  CreateFolderBody,
  CreateTripBody,
  IdParam,
  ListTripsQuery,
  MoveTripBody,
  ReorderTripsBody,
  TripIdParam,
  UpdateFolderBody,
  UpdateTripBody,
} from '../../contracts/index';
import { validate, validated } from '../../platform/http/validate';
import { idempotent } from '../../platform/http/idempotency';
import { accessOf, withTripAccess, withTripRead } from '../../platform/http/withTripAccess';
import { tripsService } from './trips.service';
import { toDashboardStats, toFolderDTO, toTripDTO } from './trips.presenter';

export const tripsRouter = Router();

// ── Folders (before /trips/:tripId so paths don't collide) ──────────

tripsRouter.get('/folders', validate({}), async (req, res) => {
  const folders = await tripsService.listFolders(req.ctx.userId);
  res.json({ items: folders.map(toFolderDTO) });
});

tripsRouter.post('/folders', validate({ body: CreateFolderBody }), async (req, res) => {
  const folder = await tripsService.createFolder(
    req.ctx.userId,
    validated.body(req, CreateFolderBody),
  );
  res.status(201).json(toFolderDTO({ ...folder, tripCount: 0 }));
});

tripsRouter.patch(
  '/folders/:id',
  validate({ params: IdParam, body: UpdateFolderBody }),
  async (req, res) => {
    const { id } = validated.params(req, IdParam);
    const folder = await tripsService.updateFolder(
      req.ctx.userId,
      id,
      validated.body(req, UpdateFolderBody),
    );
    res.json(toFolderDTO({ ...folder, tripCount: 0 }));
  },
);

tripsRouter.delete('/folders/:id', validate({ params: IdParam }), async (req, res) => {
  const { id } = validated.params(req, IdParam);
  // Trips are unfiled, never deleted (FR-FOLD-06). The count lets the client
  // confirm honestly.
  const result = await tripsService.deleteFolder(req.ctx.userId, id);
  res.json(result);
});

// ── Trips ───────────────────────────────────────────────────────────

tripsRouter.get('/trips', validate({ query: ListTripsQuery }), async (req, res) => {
  const query = validated.query(req, ListTripsQuery);
  const trips = await tripsService.list(req.ctx.userId, query);
  res.json({ items: trips.map((trip) => toTripDTO(trip)) });
});

tripsRouter.get('/trips/dashboard', validate({}), async (req, res) => {
  const trips = await tripsService.list(req.ctx.userId, { view: 'dashboard' });
  res.json({
    items: trips.map((trip) => toTripDTO(trip)),
    stats: toDashboardStats(trips),
  });
});

tripsRouter.post(
  '/trips',
  validate({ body: CreateTripBody }),
  idempotent(),
  async (req, res) => {
    const trip = await tripsService.create(req.ctx.userId, validated.body(req, CreateTripBody));
    res.status(201).json(toTripDTO(trip));
  },
);

tripsRouter.get(
  '/trips/:tripId',
  validate({ params: TripIdParam }),
  withTripRead('trip:view'),
  async (req, res) => {
    const trip = await tripsService.get(req.ctx.userId, accessOf(req).tripId);
    res.json(toTripDTO(trip));
  },
);

tripsRouter.patch(
  '/trips/:tripId',
  validate({ params: TripIdParam, body: UpdateTripBody }),
  withTripAccess('trip:edit'),
  async (req, res) => {
    const trip = await tripsService.update(accessOf(req), validated.body(req, UpdateTripBody));
    res.json(toTripDTO(trip));
  },
);

tripsRouter.delete(
  '/trips/:tripId',
  validate({ params: TripIdParam }),
  withTripAccess('trip:delete'),
  async (req, res) => {
    await tripsService.remove(accessOf(req));
    res.status(204).end();
  },
);

tripsRouter.post(
  '/trips/:tripId/restore',
  validate({ params: TripIdParam }),
  async (req, res) => {
    // Deliberately not behind withTripAccess: the trip is soft-deleted, so the
    // access loader cannot see it. Ownership is re-checked in the service.
    await tripsService.restore(req.ctx.userId, req.params.tripId as string);
    res.status(204).end();
  },
);

tripsRouter.post(
  '/trips/:tripId/archive',
  validate({ params: TripIdParam }),
  withTripAccess('trip:archive', { requireMutable: false }),
  async (req, res) => {
    await tripsService.archive(accessOf(req), true);
    res.status(204).end();
  },
);

tripsRouter.post(
  '/trips/:tripId/unarchive',
  validate({ params: TripIdParam }),
  withTripAccess('trip:archive', { requireMutable: false }),
  async (req, res) => {
    await tripsService.archive(accessOf(req), false);
    res.status(204).end();
  },
);

const PinBody = z.object({ pinned: z.boolean() });

tripsRouter.post(
  '/trips/:tripId/pin',
  validate({ params: TripIdParam, body: PinBody }),
  withTripRead('trip:view'),
  async (req, res) => {
    // Pinning is per-user (FR-TRIP-06), so any member may pin — it changes
    // nothing for anyone else.
    const { pinned } = validated.body(req, PinBody);
    await tripsService.setPinned(accessOf(req), pinned);
    res.status(204).end();
  },
);

tripsRouter.post(
  '/trips/:tripId/duplicate',
  validate({ params: TripIdParam }),
  withTripRead('trip:duplicate'),
  idempotent(),
  async (req, res) => {
    const trip = await tripsService.duplicate(accessOf(req));
    res.status(201).json(toTripDTO(trip));
  },
);

tripsRouter.patch(
  '/trips/:tripId/folder',
  validate({ params: TripIdParam, body: MoveTripBody }),
  withTripAccess('trip:edit'),
  async (req, res) => {
    const { folderId } = validated.body(req, MoveTripBody);
    await tripsService.moveToFolder(accessOf(req), folderId);
    res.status(204).end();
  },
);

tripsRouter.post(
  '/trips/reorder',
  validate({ body: ReorderTripsBody }),
  async (req, res) => {
    const { orderedTripIds } = validated.body(req, ReorderTripsBody);
    await tripsService.reorder(req.ctx.userId, orderedTripIds);
    res.status(204).end();
  },
);
