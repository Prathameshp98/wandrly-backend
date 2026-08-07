/**
 * Place search and the trip map.
 *
 * The provider is stubbed: hitting Nominatim for real would breach their
 * ~1 req/sec usage policy from a test suite, and hitting Google would cost
 * money. What matters is OUR behaviour — caching, pin assembly, bounds, and
 * that the API key never escapes to a client.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { authed } from '../support/api';
import { closeTestDatabase, resetDatabase } from '../support/db';
import { addMember, createUser } from '../support/factories';

const searchSpy = vi.fn();

vi.mock('../../src/platform/maps/index', () => ({
  maps: {
    name: 'osm',
    isConfigured: true,
    supportsStaticMaps: false,
    search: (...args: unknown[]) => searchSpy(...args),
    details: async () => null,
    staticMapUrl: () => null,
  },
}));

const KIYOMIZU = {
  placeId: 'W12345',
  name: 'Kiyomizu-dera',
  address: 'Kiyomizu, Higashiyama Ward, Kyoto, Japan',
  lat: 34.9949,
  lng: 135.785,
  category: 'place_of_worship',
};

let uniqueQuery = '';

beforeEach(async () => {
  await resetDatabase();
  // The place cache is long-lived by design, so each test needs its own query.
  uniqueQuery = `temple-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  searchSpy.mockReset();
  searchSpy.mockResolvedValue([KIYOMIZU]);
});

afterAll(async () => {
  await closeTestDatabase();
});

/** A trip with two located blocks on different days, plus one without a location. */
async function tripWithPins(token: string) {
  const { body: trip } = await authed(token)
    .post('/v1/trips')
    .send({ destination: 'Kyoto', startDate: '2026-05-18', endDate: '2026-05-19' })
    .expect(201);

  const { body: canvas } = await authed(token).get(`/v1/trips/${trip.id}/canvas`);

  await authed(token)
    .post(`/v1/trips/${trip.id}/days/${canvas.days[0].id}/blocks`)
    .send({
      type: 'ACTIVITY',
      title: 'Kiyomizu-dera',
      sections: { map: { lat: 34.9949, lng: 135.785, name: 'Kiyomizu-dera' } },
    })
    .expect(201);

  await authed(token)
    .post(`/v1/trips/${trip.id}/days/${canvas.days[1].id}/blocks`)
    .send({
      type: 'RESTAURANT',
      title: 'Kikunoi',
      sections: { map: { lat: 35.0036, lng: 135.7788, name: 'Kikunoi' } },
    })
    .expect(201);

  // A block with no location must not appear as a pin.
  await authed(token)
    .post(`/v1/trips/${trip.id}/days/${canvas.days[0].id}/blocks`)
    .send({ type: 'NOTE', title: 'Set an alarm' })
    .expect(201);

  return trip;
}

describe('place search', () => {
  it('returns places with coordinates and the provider in use', async () => {
    const user = await createUser();
    const { body } = await authed(user.token)
      .get(`/v1/places/search?q=${uniqueQuery}`)
      .expect(200);

    // Free provider by default — no key, no billing account.
    expect(body.provider).toBe('osm');
    expect(body.items).toHaveLength(1);
    expect(body.items[0].name).toBe('Kiyomizu-dera');
    expect(body.items[0].lat).toBeCloseTo(34.9949, 3);
    expect(body.items[0].placeId).toBeTruthy();
  });

  it('caches, so typing does not hammer a rate-limited provider', async () => {
    const user = await createUser();

    await authed(user.token).get(`/v1/places/search?q=${uniqueQuery}`).expect(200);
    await authed(user.token).get(`/v1/places/search?q=${uniqueQuery}`).expect(200);
    await authed(user.token).get(`/v1/places/search?q=${uniqueQuery.toUpperCase()}`).expect(200);

    expect(searchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not cache an empty result, so an outage is not pinned for a week', async () => {
    const user = await createUser();
    searchSpy.mockResolvedValue([]);

    await authed(user.token).get(`/v1/places/search?q=${uniqueQuery}`).expect(200);
    await authed(user.token).get(`/v1/places/search?q=${uniqueQuery}`).expect(200);

    expect(searchSpy).toHaveBeenCalledTimes(2);
  });

  it('survives a provider outage without failing the request', async () => {
    // FR-NFR-REL-04 — a geocoder being down must not block trip creation.
    const user = await createUser();
    searchSpy.mockRejectedValue(new Error('network down'));

    await authed(user.token).get(`/v1/places/search?q=${uniqueQuery}`).expect(500);
  });

  it('rejects a too-short query', async () => {
    const user = await createUser();
    await authed(user.token).get('/v1/places/search?q=a').expect(400);
  });

  it('requires authentication', async () => {
    await authed('nope').get('/v1/places/search?q=kyoto').expect(401);
  });
});

describe('trip map (FR-PANEL-04/05)', () => {
  it('returns every located block as a pin, with day numbers for colouring', async () => {
    const user = await createUser();
    const trip = await tripWithPins(user.token);

    const { body } = await authed(user.token).get(`/v1/trips/${trip.id}/map`).expect(200);

    // Two located blocks; the NOTE without a map section is excluded.
    expect(body.pins).toHaveLength(2);
    expect(body.pins[0].dayNumber).toBe(1);
    expect(body.pins[1].dayNumber).toBe(2);
    expect(body.pins[0].name).toBe('Kiyomizu-dera');
    // Deep-link targets so clicking a pin can open the block.
    expect(body.pins[0].blockId).toBeTruthy();
    expect(body.pins[0].dayId).toBeTruthy();
  });

  it('computes a centre and bounding box so the client need not guess zoom', async () => {
    const user = await createUser();
    const trip = await tripWithPins(user.token);

    const { body } = await authed(user.token).get(`/v1/trips/${trip.id}/map`).expect(200);

    expect(body.center.lat).toBeCloseTo((34.9949 + 35.0036) / 2, 4);
    expect(body.bounds.north).toBeCloseTo(35.0036, 4);
    expect(body.bounds.south).toBeCloseTo(34.9949, 4);
    expect(body.bounds.west).toBeCloseTo(135.7788, 4);
  });

  it('returns an empty map rather than an error when nothing is located', async () => {
    const user = await createUser();
    const { body: trip } = await authed(user.token)
      .post('/v1/trips')
      .send({ destination: 'Nowhere' })
      .expect(201);

    const { body } = await authed(user.token).get(`/v1/trips/${trip.id}/map`).expect(200);
    expect(body.pins).toHaveLength(0);
    expect(body.center).toBeNull();
    expect(body.bounds).toBeNull();
  });

  it('never leaks an API key to the client', async () => {
    // The static-map URL embeds the key, so it must stay server-side.
    const user = await createUser();
    const trip = await tripWithPins(user.token);

    const { body } = await authed(user.token).get(`/v1/trips/${trip.id}/map`);
    const payload = JSON.stringify(body);

    expect(payload).not.toMatch(/key=/i);
    expect(payload).not.toMatch(/staticmap/i);
    expect(payload).not.toMatch(/apiKey|api_key/i);
  });

  it('is visible to any member', async () => {
    const owner = await createUser();
    const trip = await tripWithPins(owner.token);
    const viewer = await addMember(trip.id, 'VIEWER');

    const { body } = await authed(viewer.token).get(`/v1/trips/${trip.id}/map`).expect(200);
    expect(body.pins).toHaveLength(2);
  });

  it('404s for someone who is not a member', async () => {
    const owner = await createUser();
    const trip = await tripWithPins(owner.token);
    const stranger = await createUser();

    await authed(stranger.token).get(`/v1/trips/${trip.id}/map`).expect(404);
  });
});
