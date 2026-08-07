/**
 * Third-party image search and import.
 *
 * The provider is stubbed with `vi.mock` — hitting Pexels for real would burn
 * the 200/hour budget, need a key in CI, and make the suite depend on someone
 * else's uptime. What matters here is OUR behaviour: caching, attribution,
 * idempotency, and honouring the provider's attach mode.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { authed } from '../support/api';
import { closeTestDatabase, resetDatabase } from '../support/db';
import { createUser } from '../support/factories';

const PHOTO = {
  id: '12345',
  description: 'Kiyomizu-dera temple at dawn',
  url: 'https://images.pexels.test/full.jpg',
  thumbUrl: 'https://images.pexels.test/thumb.jpg',
  width: 1920,
  height: 1080,
  tone: '#8A6B4F',
  photographer: 'Ayumi Tanaka',
  photographerUrl: 'https://www.pexels.com/@ayumi',
  sourceUrl: 'https://www.pexels.com/photo/12345/',
};

const searchSpy = vi.fn();
const trackSpy = vi.fn(async () => undefined);

vi.mock('../../src/platform/images/index', async () => {
  const actual = await vi.importActual<typeof import('../../src/platform/images/index')>(
    '../../src/platform/images/index',
  );

  const stub = {
    name: 'pexels',
    attachMode: 'IMPORT' as const,
    attributionLabel: 'Photos provided by Pexels',
    isConfigured: true,
    search: (...args: unknown[]) => searchSpy(...args),
    trackUse: () => trackSpy(),
  };

  return {
    ...actual,
    providerByName: (name: string) => (name === 'pexels' ? stub : null),
    configuredProviders: () => [stub],
    defaultProvider: () => stub,
  };
});

/** A 1×1 PNG, so the import path passes magic-byte validation. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  (() => {
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write('IHDR', 4);
    ihdr.writeUInt32BE(1, 8);
    ihdr.writeUInt32BE(1, 12);
    return ihdr;
  })(),
  Buffer.alloc(64, 0x40),
]);

/**
 * A distinct query per test.
 *
 * The suite isolates by unique data rather than truncation (see
 * `test/support/db.ts`), and `image_search_cache` is deliberately long-lived —
 * so a shared query string would be served from a previous test's cache entry,
 * or a previous RUN's.
 */
let uniqueQuery = '';

beforeEach(async () => {
  await resetDatabase();
  uniqueQuery = `kyoto-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  searchSpy.mockReset();
  trackSpy.mockClear();
  searchSpy.mockResolvedValue({ photos: [PHOTO], page: 1, totalPages: 3 });

  // The import step fetches the provider's CDN.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(new Uint8Array(PNG), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
      }),
    ),
  );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await closeTestDatabase();
});

describe('sources', () => {
  it('advertises configured providers and their attach mode', async () => {
    const user = await createUser();
    const { body } = await authed(user.token).get('/v1/media/sources').expect(200);

    expect(body.items).toHaveLength(1);
    expect(body.items[0].name).toBe('pexels');
    expect(body.items[0].attachMode).toBe('IMPORT');
    expect(body.items[0].attributionLabel).toMatch(/Pexels/);
  });
});

describe('search', () => {
  it('returns photos with everything attribution needs', async () => {
    const user = await createUser();
    const { body } = await authed(user.token)
      .get(`/v1/media/search?q=${uniqueQuery}%20temple`)
      .expect(200);

    expect(body.provider).toBe('pexels');
    // The licence obligation is part of the response, not left to the client.
    expect(body.attributionLabel).toMatch(/Pexels/);
    expect(body.photos).toHaveLength(1);
    expect(body.photos[0].photographer).toBe('Ayumi Tanaka');
    expect(body.photos[0].photographerUrl).toBeTruthy();
    expect(body.photos[0].sourceUrl).toBeTruthy();
  });

  it('caches, so a search-as-you-type field cannot exhaust the rate limit', async () => {
    const user = await createUser();

    await authed(user.token).get(`/v1/media/search?q=${uniqueQuery}`).expect(200);
    await authed(user.token).get(`/v1/media/search?q=${uniqueQuery}`).expect(200);
    // Case-insensitive: the cache key is the normalised query.
    await authed(user.token)
      .get(`/v1/media/search?q=${uniqueQuery.toUpperCase()}`)
      .expect(200);

    expect(searchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not cache an empty result, so a rate-limit blip is not pinned for an hour', async () => {
    const user = await createUser();
    searchSpy.mockResolvedValue({ photos: [], page: 1, totalPages: 0 });

    await authed(user.token).get(`/v1/media/search?q=${uniqueQuery}`).expect(200);
    await authed(user.token).get(`/v1/media/search?q=${uniqueQuery}`).expect(200);

    expect(searchSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects a too-short query', async () => {
    const user = await createUser();
    await authed(user.token).get('/v1/media/search?q=a').expect(400);
  });

  it('rejects an unknown provider', async () => {
    const user = await createUser();
    await authed(user.token)
      .get(`/v1/media/search?q=${uniqueQuery}&provider=getty`)
      .expect(422);
  });

  it('requires authentication', async () => {
    await authed('nope').get('/v1/media/search?q=anything').expect(401);
  });
});

describe('attach', () => {
  it('imports the photo and carries attribution onto the asset', async () => {
    const user = await createUser();
    await authed(user.token).get(`/v1/media/search?q=${uniqueQuery}`).expect(200);

    const { body } = await authed(user.token)
      .post('/v1/media/attach')
      .send({ photoId: PHOTO.id })
      .expect(201);

    expect(body.provider).toBe('pexels');
    expect(body.attribution).toBe('Photo by Ayumi Tanaka on Pexels');
    expect(body.attributionUrl).toBe(PHOTO.photographerUrl);
    // IMPORT mode self-hosts, so there is no remote URL to embed.
    expect(body.remoteUrl).toBeNull();

    // It behaves like any other asset from here on.
    const { body: listed } = await authed(user.token).get('/v1/media');
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].attribution).toBe('Photo by Ayumi Tanaka on Pexels');
    expect(listed.items[0].altText).toBe(PHOTO.description);

    await authed(user.token).get(`/v1/media/${body.id}/content`).expect(200);
  });

  it('is idempotent — picking the same photo twice reuses the asset', async () => {
    const user = await createUser();
    await authed(user.token).get(`/v1/media/search?q=${uniqueQuery}`).expect(200);

    const first = await authed(user.token)
      .post('/v1/media/attach')
      .send({ photoId: PHOTO.id })
      .expect(201);
    const second = await authed(user.token)
      .post('/v1/media/attach')
      .send({ photoId: PHOTO.id })
      .expect(201);

    expect(second.body.id).toBe(first.body.id);

    const { body } = await authed(user.token).get('/v1/media');
    expect(body.items).toHaveLength(1);
  });

  it('validates the downloaded bytes rather than trusting the provider', async () => {
    // A provider is still an untrusted source (FR-NFR-SEC-05).
    const user = await createUser();
    await authed(user.token).get(`/v1/media/search?q=${uniqueQuery}`).expect(200);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(new Uint8Array(Buffer.from('<html>not an image</html>')), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      ),
    );

    const { body } = await authed(user.token)
      .post('/v1/media/attach')
      .send({ photoId: PHOTO.id })
      .expect(422);

    expect(body.error.message).toMatch(/not an image/i);
  });

  it('rejects a photo that was never in a search result', async () => {
    const user = await createUser();
    await authed(user.token)
      .post('/v1/media/attach')
      .send({ photoId: 'never-seen' })
      .expect(404);
  });

  it('keeps one user’s imports out of another’s library', async () => {
    const a = await createUser();
    const b = await createUser();

    await authed(a.token).get(`/v1/media/search?q=${uniqueQuery}`).expect(200);
    await authed(a.token).post('/v1/media/attach').send({ photoId: PHOTO.id }).expect(201);

    const { body } = await authed(b.token).get('/v1/media');
    expect(body.items).toHaveLength(0);
  });
});
