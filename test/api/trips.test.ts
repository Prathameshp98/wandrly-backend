/**
 * Trips, folders, and idempotency — API tests.
 *
 * This is the module that makes the API usable end-to-end: before it, a trip
 * could only be created by a factory or the seed script.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { authed } from '../support/api';
import { closeTestDatabase, resetDatabase, seedFxRates } from '../support/db';
import { addMember, createTrip, createUser } from '../support/factories';

beforeEach(async () => {
  await resetDatabase();
  await seedFxRates();
});

afterAll(async () => {
  // Each file owns its pool under `isolate: true`, so each closes its own.
  await closeTestDatabase();
});

describe('POST /v1/trips', () => {
  it('creates the whole minimum graph in one call', async () => {
    const user = await createUser();

    const { body } = await authed(user.token)
      .post('/v1/trips')
      .send({
        destination: 'Kyoto, Japan',
        title: 'Kyoto in Spring',
        startDate: '2026-05-18',
        endDate: '2026-05-24',
      })
      .expect(201);

    expect(body.title).toBe('Kyoto in Spring');
    expect(body.role).toBe('OWNER');
    expect(body.dayCount).toBe(7); // 18th–24th inclusive
    expect(body.variantCount).toBe(1);
    expect(body.memberCount).toBe(1);
    expect(body.dateRangeLabel).toBe('18 May – 24');
    expect(body.status).toBe('DRAFT');

    // The ledger is immediately reachable — the owner is already a participant.
    const { body: participants } = await authed(user.token)
      .get(`/v1/trips/${body.id}/participants`)
      .expect(200);
    expect(participants.items).toHaveLength(1);
  });

  it('defaults the title to the destination', async () => {
    const user = await createUser();
    const { body } = await authed(user.token)
      .post('/v1/trips')
      .send({ destination: 'Lisbon, Portugal' })
      .expect(201);

    expect(body.title).toBe('Lisbon, Portugal');
    expect(body.dayCount).toBe(0);
    expect(body.dateRangeLabel).toBe('Dates TBD');
  });

  it('creates an expenses-only trip with no days', async () => {
    const user = await createUser();
    const { body } = await authed(user.token)
      .post('/v1/trips')
      .send({
        destination: 'Goa weekend',
        tripMode: 'EXPENSES_ONLY',
        startDate: '2026-06-01',
        endDate: '2026-06-03',
      })
      .expect(201);

    expect(body.tripMode).toBe('EXPENSES_ONLY');
    expect(body.dayCount).toBe(0); // FR-SPLIT-46 — no canvas surfaces
  });

  it('rejects a folder belonging to someone else', async () => {
    const user = await createUser();
    const stranger = await createUser();
    const { body: folder } = await authed(stranger.token)
      .post('/v1/folders')
      .send({ name: 'Not yours' })
      .expect(201);

    await authed(user.token)
      .post('/v1/trips')
      .send({ destination: 'Anywhere', folderId: folder.id })
      .expect(404);
  });
});

describe('readiness (FR-DASH-07)', () => {
  it('is 0% with no bookable blocks, not a fabricated number', async () => {
    const user = await createUser();
    const { body } = await authed(user.token)
      .post('/v1/trips')
      .send({ destination: 'Kyoto', startDate: '2026-05-18', endDate: '2026-05-20' })
      .expect(201);

    expect(body.readinessPct).toBe(0);
    expect(body.bookableBlockCount).toBe(0);
  });

  it('is 100% for a completed trip', async () => {
    const user = await createUser();
    const trip = await createTrip({ ownerId: user.id });

    const { body: current } = await authed(user.token).get(`/v1/trips/${trip.id}`);

    const { body } = await authed(user.token)
      .patch(`/v1/trips/${trip.id}`)
      .send({ version: current.version, status: 'COMPLETED' })
      .expect(200);

    expect(body.readinessPct).toBe(100);
  });
});

describe('date changes (FR-TRIP-14)', () => {
  const createDatedTrip = async (token: string) => {
    const { body } = await authed(token)
      .post('/v1/trips')
      .send({ destination: 'Kyoto', startDate: '2026-05-18', endDate: '2026-05-22' })
      .expect(201);
    return body;
  };

  it('refuses to guess when the day count would change', async () => {
    const user = await createUser();
    const trip = await createDatedTrip(user.token);
    expect(trip.dayCount).toBe(5);

    const { body } = await authed(user.token)
      .patch(`/v1/trips/${trip.id}`)
      .send({ version: trip.version, endDate: '2026-05-20' })
      .expect(409);

    expect(body.error.code).toBe('CONFLICT_DATE_CHANGE');
    expect(body.error.details).toStrictEqual({ currentDayCount: 5, requestedDayCount: 3 });
  });

  it('TRUNCATE drops the surplus days', async () => {
    const user = await createUser();
    const trip = await createDatedTrip(user.token);

    const { body } = await authed(user.token)
      .patch(`/v1/trips/${trip.id}`)
      .send({ version: trip.version, endDate: '2026-05-20', dateChangeStrategy: 'TRUNCATE' })
      .expect(200);

    expect(body.dayCount).toBe(3);
  });

  it('EXTEND appends empty days', async () => {
    const user = await createUser();
    const trip = await createDatedTrip(user.token);

    const { body } = await authed(user.token)
      .patch(`/v1/trips/${trip.id}`)
      .send({ version: trip.version, endDate: '2026-05-24', dateChangeStrategy: 'EXTEND' })
      .expect(200);

    expect(body.dayCount).toBe(7);
  });

  it('SHIFT keeps every day and moves the dates', async () => {
    const user = await createUser();
    const trip = await createDatedTrip(user.token);

    const { body } = await authed(user.token)
      .patch(`/v1/trips/${trip.id}`)
      .send({
        version: trip.version,
        startDate: '2026-06-01',
        endDate: '2026-06-05',
        dateChangeStrategy: 'SHIFT',
      })
      .expect(200);

    expect(body.dayCount).toBe(5);
    expect(body.startDate).toBe('2026-06-01');
  });
});

describe('optimistic locking', () => {
  it('rejects a stale version with the current state', async () => {
    const user = await createUser();
    const trip = await createTrip({ ownerId: user.id });

    await authed(user.token)
      .patch(`/v1/trips/${trip.id}`)
      .send({ version: 1, title: 'First' })
      .expect(200);

    const { body } = await authed(user.token)
      .patch(`/v1/trips/${trip.id}`)
      .send({ version: 1, title: 'Second' })
      .expect(409);

    expect(body.error.code).toBe('CONFLICT_STALE');
    expect(body.error.details.current.title).toBe('First');
  });
});

describe('per-user pinning (FR-TRIP-06)', () => {
  it('one member pinning does not affect another', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const editor = await addMember(trip.id, 'EDITOR');

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/pin`)
      .send({ pinned: true })
      .expect(204);

    const { body: ownerView } = await authed(owner.token).get('/v1/trips');
    const { body: editorView } = await authed(editor.token).get('/v1/trips');

    expect(ownerView.items[0].isPinned).toBe(true);
    expect(editorView.items[0].isPinned).toBe(false);
  });
});

describe('archive and delete', () => {
  it('archives, hides from dashboard, and restores', async () => {
    const user = await createUser();
    const trip = await createTrip({ ownerId: user.id });

    await authed(user.token).post(`/v1/trips/${trip.id}/archive`).expect(204);

    const { body: dashboard } = await authed(user.token).get('/v1/trips?view=dashboard');
    expect(dashboard.items).toHaveLength(0);

    const { body: archive } = await authed(user.token).get('/v1/trips?view=archive');
    expect(archive.items).toHaveLength(1);

    await authed(user.token).post(`/v1/trips/${trip.id}/unarchive`).expect(204);
    const { body: after } = await authed(user.token).get('/v1/trips?view=dashboard');
    expect(after.items).toHaveLength(1);
  });

  it('soft-deletes and restores', async () => {
    const user = await createUser();
    const trip = await createTrip({ ownerId: user.id });

    await authed(user.token).delete(`/v1/trips/${trip.id}`).expect(204);
    await authed(user.token).get(`/v1/trips/${trip.id}`).expect(404);

    await authed(user.token).post(`/v1/trips/${trip.id}/restore`).expect(204);
    await authed(user.token).get(`/v1/trips/${trip.id}`).expect(200);
  });

  it('only the OWNER may delete', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const editor = await addMember(trip.id, 'EDITOR');

    await authed(editor.token).delete(`/v1/trips/${trip.id}`).expect(403);
    // …but an Editor may archive.
    await authed(editor.token).post(`/v1/trips/${trip.id}/archive`).expect(204);
  });
});

describe('duplicate (FR-TRIP-07 / FR-SPLIT-45)', () => {
  it('copies the itinerary but never the crew or the ledger', async () => {
    const owner = await createUser();
    const { body: source } = await authed(owner.token)
      .post('/v1/trips')
      .send({ destination: 'Kyoto', startDate: '2026-05-18', endDate: '2026-05-20' })
      .expect(201);

    await addMember(source.id, 'EDITOR');
    await authed(owner.token)
      .post(`/v1/trips/${source.id}/participants`)
      .send({ displayName: 'Priya' })
      .expect(201);

    const { body: copy } = await authed(owner.token)
      .post(`/v1/trips/${source.id}/duplicate`)
      .expect(201);

    expect(copy.title).toBe('Kyoto · copy');
    expect(copy.dayCount).toBe(3); // itinerary copied
    expect(copy.status).toBe('DRAFT');
    expect(copy.memberCount).toBe(1); // crew NOT copied

    // The ledger starts empty — money that changed hands did not do so twice.
    const { body: participants } = await authed(owner.token).get(
      `/v1/trips/${copy.id}/participants`,
    );
    expect(participants.items).toHaveLength(1);

    const { body: expenses } = await authed(owner.token).get(`/v1/trips/${copy.id}/expenses`);
    expect(expenses.items).toHaveLength(0);
  });
});

describe('views', () => {
  it('separates owned trips from shared ones', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const editor = await addMember(trip.id, 'EDITOR');

    const { body: ownerShared } = await authed(owner.token).get('/v1/trips?view=shared');
    expect(ownerShared.items).toHaveLength(0); // you don't share with yourself

    const { body: editorShared } = await authed(editor.token).get('/v1/trips?view=shared');
    expect(editorShared.items).toHaveLength(1);
    expect(editorShared.items[0].role).toBe('EDITOR');
  });

  it('filters by search across title, destination and subtitle', async () => {
    const user = await createUser();
    await createTrip({ ownerId: user.id, title: 'Kyoto in Spring' });
    await createTrip({ ownerId: user.id, title: 'Iceland Ring Road' });

    const { body } = await authed(user.token).get('/v1/trips?search=kyoto');
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe('Kyoto in Spring');
  });

  it('never returns another user’s trips', async () => {
    const owner = await createUser();
    await createTrip({ ownerId: owner.id });
    const stranger = await createUser();

    const { body } = await authed(stranger.token).get('/v1/trips');
    expect(body.items).toHaveLength(0);
  });

  it('returns dashboard stats', async () => {
    const user = await createUser();
    await authed(user.token)
      .post('/v1/trips')
      .send({ destination: 'Kyoto', startDate: '2026-05-18', endDate: '2026-05-20' })
      .expect(201);

    const { body } = await authed(user.token).get('/v1/trips/dashboard').expect(200);
    expect(body.stats.tripCount).toBe(1);
    expect(body.stats.daysPlanned).toBe(3);
  });
});

describe('folders', () => {
  it('creates, lists with live counts, and updates', async () => {
    const user = await createUser();

    const { body: folder } = await authed(user.token)
      .post('/v1/folders')
      .send({ name: 'Japan 2026', emoji: '🗾', tone: 'gold' })
      .expect(201);

    await authed(user.token)
      .post('/v1/trips')
      .send({ destination: 'Kyoto', folderId: folder.id })
      .expect(201);

    const { body } = await authed(user.token).get('/v1/folders').expect(200);
    expect(body.items[0].tripCount).toBe(1);

    await authed(user.token)
      .patch(`/v1/folders/${folder.id}`)
      .send({ name: 'Japan 2027' })
      .expect(200);
  });

  it('deleting a folder unfiles its trips rather than deleting them', async () => {
    const user = await createUser();
    const { body: folder } = await authed(user.token)
      .post('/v1/folders')
      .send({ name: 'Temp' })
      .expect(201);

    await authed(user.token)
      .post('/v1/trips')
      .send({ destination: 'Kyoto', folderId: folder.id })
      .expect(201);

    const { body } = await authed(user.token)
      .delete(`/v1/folders/${folder.id}`)
      .expect(200);

    expect(body.unfiledTrips).toBe(1);

    // The trip survives, now unfiled.
    const { body: trips } = await authed(user.token).get('/v1/trips');
    expect(trips.items).toHaveLength(1);
    expect(trips.items[0].folderId).toBeNull();
  });

  it('excludes archived trips from folder counts', async () => {
    const user = await createUser();
    const { body: folder } = await authed(user.token)
      .post('/v1/folders')
      .send({ name: 'Japan' })
      .expect(201);

    const { body: trip } = await authed(user.token)
      .post('/v1/trips')
      .send({ destination: 'Kyoto', folderId: folder.id })
      .expect(201);

    await authed(user.token).post(`/v1/trips/${trip.id}/archive`).expect(204);

    const { body } = await authed(user.token).get('/v1/folders');
    expect(body.items[0].tripCount).toBe(0);
  });
});

describe('idempotency (§8.8)', () => {
  it('replays the first response instead of creating a second trip', async () => {
    const user = await createUser();
    const key = 'test-key-abc-123';
    const payload = { destination: 'Kyoto, Japan' };

    const first = await authed(user.token)
      .post('/v1/trips')
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(201);

    const second = await authed(user.token)
      .post('/v1/trips')
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(201);

    expect(second.body.id).toBe(first.body.id);
    expect(second.headers['idempotent-replay']).toBe('true');

    const { body } = await authed(user.token).get('/v1/trips');
    expect(body.items).toHaveLength(1);
  });

  it('rejects the same key with a different body', async () => {
    const user = await createUser();
    const key = 'test-key-xyz-789';

    await authed(user.token)
      .post('/v1/trips')
      .set('Idempotency-Key', key)
      .send({ destination: 'Kyoto' })
      .expect(201);

    const { body } = await authed(user.token)
      .post('/v1/trips')
      .set('Idempotency-Key', key)
      .send({ destination: 'Somewhere else' })
      .expect(409);

    expect(body.error.code).toBe('CONFLICT_IDEMPOTENCY_MISMATCH');
  });

  it('scopes keys per user, so two people can use the same key', async () => {
    const a = await createUser();
    const b = await createUser();
    const key = 'shared-key';

    await authed(a.token)
      .post('/v1/trips')
      .set('Idempotency-Key', key)
      .send({ destination: 'Kyoto' })
      .expect(201);

    await authed(b.token)
      .post('/v1/trips')
      .set('Idempotency-Key', key)
      .send({ destination: 'Tokyo' })
      .expect(201);
  });

  it('behaves normally when no key is sent', async () => {
    const user = await createUser();
    await authed(user.token).post('/v1/trips').send({ destination: 'A' }).expect(201);
    await authed(user.token).post('/v1/trips').send({ destination: 'A' }).expect(201);

    const { body } = await authed(user.token).get('/v1/trips');
    expect(body.items).toHaveLength(2);
  });
});
