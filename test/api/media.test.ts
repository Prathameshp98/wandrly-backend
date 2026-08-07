/**
 * Media uploads.
 *
 * The security assertions are the point: type is decided by MAGIC BYTES, and
 * EXIF is stripped before anything is persisted, so a holiday photo cannot
 * disclose where someone lives.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { authed } from '../support/api';
import { closeTestDatabase, resetDatabase } from '../support/db';
import { createUser } from '../support/factories';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

/** Minimal valid PNG: signature + IHDR declaring 1×1. */
function png(width = 1, height = 1): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([signature, ihdr, Buffer.alloc(64, 0x7f)]);
}

/**
 * JPEG with an APP1 (EXIF) segment carrying a recognisable GPS-ish payload,
 * followed by a Start-Of-Scan so the stripper has a real chain to walk.
 */
function jpegWithExif(): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const secret = Buffer.from('GPSLATITUDE_SECRET_LOCATION', 'ascii');

  const app1Payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), secret]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    (() => {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(app1Payload.length + 2);
      return len;
    })(),
    app1Payload,
  ]);

  // SOF0 so dimensions are readable.
  const sof0 = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x60, 0x03,
                            0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const sos = Buffer.concat([
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.alloc(32, 0x5a),
    Buffer.from([0xff, 0xd9]),
  ]);

  return Buffer.concat([soi, app1, sof0, sos]);
}

const upload = (token: string, body: Buffer) =>
  authed(token).post('/v1/media').set('Content-Type', 'application/octet-stream').send(body);

describe('upload', () => {
  it('accepts a PNG and reads its dimensions from the header', async () => {
    const user = await createUser();
    const { body } = await upload(user.token, png(120, 80)).expect(201);

    expect(body.mimeType).toBe('image/png');
    expect(body.width).toBe(120);
    expect(body.height).toBe(80);
    expect(body.tone).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('strips EXIF before anything is persisted (FR-NFR-SEC-05)', async () => {
    const user = await createUser();
    const original = jpegWithExif();

    // The secret is genuinely in the input.
    expect(original.includes(Buffer.from('GPSLATITUDE_SECRET_LOCATION'))).toBe(true);

    const { body } = await upload(user.token, original).expect(201);
    expect(body.mimeType).toBe('image/jpeg');

    // …and genuinely absent from what was stored.
    const stored = await authed(user.token)
      .get(`/v1/media/${body.id}/content`)
      .buffer()
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);

    const bytes = stored.body as Buffer;
    expect(bytes.includes(Buffer.from('GPSLATITUDE_SECRET_LOCATION'))).toBe(false);
    // Still a valid JPEG.
    expect(bytes.subarray(0, 3)).toStrictEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(bytes.length).toBeLessThan(original.length);
  });

  it('rejects a non-image whatever the client claims', async () => {
    const user = await createUser();
    const evil = Buffer.from('<?php system($_GET["c"]); ?>', 'ascii');

    const { body } = await authed(user.token)
      .post('/v1/media')
      // A deliberately dishonest Content-Type — only the bytes are evidence.
      .set('Content-Type', 'image/png')
      .send(evil)
      .expect(422);

    expect(body.error.message).toMatch(/not a supported image/i);
  });

  it('rejects an empty body', async () => {
    const user = await createUser();
    await upload(user.token, Buffer.alloc(0)).expect(422);
  });

  it('requires authentication', async () => {
    await authed('not-a-token').post('/v1/media').send(png()).expect(401);
  });
});

describe('quota and lifecycle', () => {
  it('reports usage', async () => {
    const user = await createUser();
    await upload(user.token, png()).expect(201);

    const { body } = await authed(user.token).get('/v1/media/usage').expect(200);
    expect(body.assetCount).toBe(1);
    expect(body.usedBytes).toBeGreaterThan(0);
    expect(body.quotaBytes).toBeGreaterThan(body.usedBytes);
  });

  it('lists only your own media', async () => {
    const a = await createUser();
    const b = await createUser();
    await upload(a.token, png()).expect(201);

    const { body: mine } = await authed(a.token).get('/v1/media');
    const { body: theirs } = await authed(b.token).get('/v1/media');

    expect(mine.items).toHaveLength(1);
    expect(theirs.items).toHaveLength(0);
  });

  it('404s another user’s bytes rather than 403 — never an existence oracle', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const { body } = await upload(owner.token, png()).expect(201);

    await authed(stranger.token).get(`/v1/media/${body.id}/content`).expect(404);
    await authed(stranger.token).delete(`/v1/media/${body.id}`).expect(404);
  });

  it('stores alt text for accessibility (FR-NFR-A11Y-09)', async () => {
    const user = await createUser();
    const { body } = await upload(user.token, png()).expect(201);

    await authed(user.token)
      .patch(`/v1/media/${body.id}`)
      .send({ altText: 'The ryokan garden at dawn' })
      .expect(200);

    const { body: listed } = await authed(user.token).get('/v1/media');
    expect(listed.items[0].altText).toBe('The ryokan garden at dawn');
  });

  it('deletes, freeing the quota', async () => {
    const user = await createUser();
    const { body } = await upload(user.token, png()).expect(201);

    await authed(user.token).delete(`/v1/media/${body.id}`).expect(204);
    await authed(user.token).get(`/v1/media/${body.id}/content`).expect(404);

    const { body: usage } = await authed(user.token).get('/v1/media/usage');
    expect(usage.assetCount).toBe(0);
    expect(usage.usedBytes).toBe(0);
  });

  it('serves bytes with nosniff, so a stored file cannot be reinterpreted', async () => {
    const user = await createUser();
    const { body } = await upload(user.token, png()).expect(201);

    const res = await authed(user.token).get(`/v1/media/${body.id}/content`).expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.headers['cache-control']).toMatch(/private/);
  });
});
