/**
 * Packing, trip notes, notifications, activity, and search.
 *
 * Packing and notes are TRIP-scoped and collaborative — the prototype kept
 * notes in localStorage, so collaborators could not see them at all.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { api, authed } from '../support/api';
import { closeTestDatabase, resetDatabase } from '../support/db';
import { addMember, createTrip, createUser } from '../support/factories';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

describe('packing list', () => {
  it('adds items and tracks who packed what (FR-PANEL-07)', async () => {
    const owner = await createUser({ displayName: 'Arjun' });
    const trip = await createTrip({ ownerId: owner.id });

    const { body: item } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/packing`)
      .send({ category: 'Documents', label: 'Passport' })
      .expect(201);

    expect(item.isChecked).toBe(false);

    await authed(owner.token)
      .patch(`/v1/trips/${trip.id}/packing/${item.id}`)
      .send({ isChecked: true })
      .expect(200);

    const { body } = await authed(owner.token).get(`/v1/trips/${trip.id}/packing`);
    expect(body.packedCount).toBe(1);
    expect(body.totalCount).toBe(1);
    expect(body.items[0].checkedBy).toBe(owner.id);
    expect(body.items[0].checkedByName).toBe('Arjun');
  });

  it('is shared across the crew, not per-user', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const editor = await addMember(trip.id, 'EDITOR');

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/packing`)
      .send({ label: 'Sunscreen' })
      .expect(201);

    const { body } = await authed(editor.token).get(`/v1/trips/${trip.id}/packing`);
    expect(body.items).toHaveLength(1);
  });

  it('clears the packer when unchecked', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });

    const { body: item } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/packing`)
      .send({ label: 'Adapter' });

    await authed(owner.token)
      .patch(`/v1/trips/${trip.id}/packing/${item.id}`)
      .send({ isChecked: true });
    await authed(owner.token)
      .patch(`/v1/trips/${trip.id}/packing/${item.id}`)
      .send({ isChecked: false });

    const { body } = await authed(owner.token).get(`/v1/trips/${trip.id}/packing`);
    expect(body.items[0].checkedBy).toBeNull();
    expect(body.items[0].checkedAt).toBeNull();
  });

  it('seeds a starter list, but never over an in-progress one', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });

    const { body: seeded } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/packing/seed`)
      .send({})
      .expect(200);
    expect(seeded.totalCount).toBeGreaterThan(5);

    // Seeding again is a no-op rather than a duplicate.
    const { body: again } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/packing/seed`)
      .send({})
      .expect(200);
    expect(again.totalCount).toBe(seeded.totalCount);

    // …unless replacement is explicit.
    const { body: replaced } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/packing/seed`)
      .send({ replace: true })
      .expect(200);
    expect(replaced.totalCount).toBe(seeded.totalCount);
  });

  it('lets a CONTRIBUTOR edit but forbids a VIEWER', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const contributor = await addMember(trip.id, 'CONTRIBUTOR');
    const viewer = await addMember(trip.id, 'VIEWER');

    await authed(contributor.token)
      .post(`/v1/trips/${trip.id}/packing`)
      .send({ label: 'Boots' })
      .expect(201);

    await authed(viewer.token)
      .post(`/v1/trips/${trip.id}/packing`)
      .send({ label: 'Nope' })
      .expect(403);
  });

  it('rejects an item from another trip', async () => {
    const owner = await createUser();
    const a = await createTrip({ ownerId: owner.id });
    const b = await createTrip({ ownerId: owner.id });

    const { body: item } = await authed(owner.token)
      .post(`/v1/trips/${a.id}/packing`)
      .send({ label: 'Passport' });

    await authed(owner.token)
      .patch(`/v1/trips/${b.id}/packing/${item.id}`)
      .send({ isChecked: true })
      .expect(404);
  });
});

describe('trip notes', () => {
  it('starts empty and round-trips through the crew (FR-PANEL-10)', async () => {
    const owner = await createUser({ displayName: 'Arjun' });
    const trip = await createTrip({ ownerId: owner.id });
    const editor = await addMember(trip.id, 'EDITOR');

    const { body: empty } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/notes`)
      .expect(200);
    expect(empty.body).toBe('');
    expect(empty.version).toBe(1);

    await authed(owner.token)
      .put(`/v1/trips/${trip.id}/notes`)
      .send({ body: 'Ryokan options near Gion', version: empty.version })
      .expect(200);

    // A collaborator sees it — the whole point versus localStorage.
    const { body: seen } = await authed(editor.token).get(`/v1/trips/${trip.id}/notes`);
    expect(seen.body).toBe('Ryokan options near Gion');
    expect(seen.updatedByName).toBe('Arjun');
    expect(seen.wordCount).toBe(4);
  });

  it('rejects a stale write rather than clobbering a collaborator', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const editor = await addMember(trip.id, 'EDITOR');

    const { body: initial } = await authed(owner.token).get(`/v1/trips/${trip.id}/notes`);

    await authed(owner.token)
      .put(`/v1/trips/${trip.id}/notes`)
      .send({ body: 'Owner wrote this', version: initial.version })
      .expect(200);

    // The editor still holds the old version.
    const { body } = await authed(editor.token)
      .put(`/v1/trips/${trip.id}/notes`)
      .send({ body: 'Editor overwrites', version: initial.version })
      .expect(409);

    expect(body.error.code).toBe('CONFLICT_STALE');
    expect(body.error.details.current.note.body).toBe('Owner wrote this');
  });

  it('forbids a VIEWER from editing', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const viewer = await addMember(trip.id, 'VIEWER');

    await authed(viewer.token)
      .put(`/v1/trips/${trip.id}/notes`)
      .send({ body: 'nope', version: 1 })
      .expect(403);
  });
});

describe('notifications', () => {
  it('are created for other members and never for yourself', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const editor = await addMember(trip.id, 'EDITOR');

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/comments`)
      .send({ body: 'What do we think?' })
      .expect(201);

    const { body: theirs } = await authed(editor.token).get('/v1/notifications');
    expect(theirs.items.length).toBeGreaterThan(0);
    expect(theirs.unreadCount).toBeGreaterThan(0);
    expect(theirs.items[0].actorId).toBe(owner.id);

    // The actor is not notified about their own action.
    const { body: mine } = await authed(owner.token).get('/v1/notifications');
    expect(mine.items).toHaveLength(0);
  });

  it('marks everything read', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const editor = await addMember(trip.id, 'EDITOR');

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/comments`)
      .send({ body: 'Hello' })
      .expect(201);

    await authed(editor.token).post('/v1/notifications/read').expect(204);

    const { body } = await authed(editor.token).get('/v1/notifications');
    expect(body.unreadCount).toBe(0);
  });

  it('filters to unread only', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const editor = await addMember(trip.id, 'EDITOR');

    await authed(owner.token).post(`/v1/trips/${trip.id}/comments`).send({ body: 'One' });
    await authed(editor.token).post('/v1/notifications/read').expect(204);
    await authed(owner.token).post(`/v1/trips/${trip.id}/comments`).send({ body: 'Two' });

    const { body } = await authed(editor.token).get('/v1/notifications?unreadOnly=true');
    expect(body.items).toHaveLength(1);
  });

  it('never leaks another user’s notifications', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    await addMember(trip.id, 'EDITOR');
    await authed(owner.token).post(`/v1/trips/${trip.id}/comments`).send({ body: 'Hi' });

    const stranger = await createUser();
    const { body } = await authed(stranger.token).get('/v1/notifications');
    expect(body.items).toHaveLength(0);
  });

  it('records an activity feed for the trip', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/participants`)
      .send({ displayName: 'Mom' })
      .expect(201);

    const { body } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/activity`)
      .expect(200);

    expect(body.items.some((e: { kind: string }) => e.kind === 'participant.created')).toBe(true);
    expect(body.items[0].actorName).toBeTruthy();
  });
});

describe('unsubscribe (FR-NOTIF-09)', () => {
  it('works with no session, and rejects a forged token', async () => {
    const user = await createUser();
    const { unsubscribeTokenFor } = await import(
      '../../src/modules/notifications/notifications.routes'
    );

    await api.get('/unsubscribe/not-a-real-token').expect(400);

    // One click, no login — an email footer cannot require a session.
    await api.get(`/unsubscribe/${unsubscribeTokenFor(user.id)}`).expect(200);

    const { db } = await import('../support/db');
    const { users } = await import('../../src/platform/db/schema/index');
    const { eq } = await import('drizzle-orm');
    const [row] = await db
      .select({ enabled: users.emailNotificationsEnabled })
      .from(users)
      .where(eq(users.id, user.id));

    expect(row!.enabled).toBe(false);
  });
});

describe('search (FR-SRCH-05/06)', () => {
  async function tripWithBlock(token: string, title: string, blockTitle: string) {
    const { body: trip } = await authed(token)
      .post('/v1/trips')
      .send({ destination: title, startDate: '2026-05-18', endDate: '2026-05-19' })
      .expect(201);
    const { body: canvas } = await authed(token).get(`/v1/trips/${trip.id}/canvas`);
    await authed(token)
      .post(`/v1/trips/${trip.id}/days/${canvas.days[0].id}/blocks`)
      .send({ type: 'RESTAURANT', title: blockTitle, meta: 'Pontocho Alley' })
      .expect(201);
    return trip;
  }

  it('finds blocks and returns deep-link targets', async () => {
    const user = await createUser();
    const trip = await tripWithBlock(user.token, 'Kyoto Japan', 'Kikunoi kaiseki');

    const { body } = await authed(user.token).get('/v1/search?q=Kikunoi').expect(200);

    expect(body.blocks).toHaveLength(1);
    const hit = body.blocks[0];
    expect(hit.tripId).toBe(trip.id);
    // Everything the client needs to scroll to and highlight it.
    expect(hit.variantId).toBeTruthy();
    expect(hit.dayId).toBeTruthy();
    expect(hit.dayNumber).toBe(1);
  });

  it('finds trips by destination', async () => {
    const user = await createUser();
    await tripWithBlock(user.token, 'Reykjavik Iceland', 'Blue Lagoon');

    const { body } = await authed(user.token).get('/v1/search?q=Reykjavik').expect(200);
    expect(body.trips).toHaveLength(1);
  });

  it('finds people by name', async () => {
    const user = await createUser();
    const trip = await createTrip({ ownerId: user.id });
    await authed(user.token)
      .post(`/v1/trips/${trip.id}/participants`)
      .send({ displayName: 'Priyanka' })
      .expect(201);

    const { body } = await authed(user.token).get('/v1/search?q=Priyank').expect(200);
    expect(body.people).toHaveLength(1);
    expect(body.people[0].displayName).toBe('Priyanka');
  });

  it('NEVER returns results from trips you are not a member of', async () => {
    const owner = await createUser();
    await tripWithBlock(owner.token, 'Kyoto Japan', 'Secret Kikunoi');

    const stranger = await createUser();
    const { body } = await authed(stranger.token).get('/v1/search?q=Kikunoi').expect(200);

    expect(body.trips).toHaveLength(0);
    expect(body.blocks).toHaveLength(0);
    expect(body.people).toHaveLength(0);
  });

  it('handles proper nouns that English stemming would mangle', async () => {
    // The reason the tsvector config is 'simple', not 'english'.
    const user = await createUser();
    await tripWithBlock(user.token, 'Kyoto Japan', 'Kiyomizu-dera');

    const { body } = await authed(user.token).get('/v1/search?q=Kiyomizu-dera').expect(200);
    expect(body.blocks.length).toBeGreaterThan(0);
  });

  it('rejects a too-short query rather than scanning everything', async () => {
    const user = await createUser();
    await authed(user.token).get('/v1/search?q=a').expect(400);
  });
});
