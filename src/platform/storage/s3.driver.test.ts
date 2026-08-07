/**
 * S3 driver, exercised against a real HTTP server rather than a mocked client.
 *
 * The point is to prove the wire behaviour: that a signed request is actually
 * produced, that path-style addressing puts the bucket where the provider
 * expects it, and that a 404 becomes `null` instead of an exception. Mocking
 * `S3Client` would assert only that we call the SDK we call.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { S3StorageDriver } from './s3.driver';

interface Request {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** Path without the query string. Split never yields an empty array. */
function pathOf(url: string | undefined): string {
  return (url ?? '').split('?')[0] ?? '';
}

const objects = new Map<string, { body: Buffer; contentType: string }>();
let requests: Request[] = [];
let server: Server;
let endpoint: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      });

      // Path-style: /<bucket>/<key>
      const key = decodeURIComponent(pathOf(req.url)).replace(/^\/[^/]+\//, '');

      if (req.method === 'PUT') {
        objects.set(key, {
          body,
          contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
        });
        res.writeHead(200, { ETag: '"stub"' }).end();
        return;
      }

      if (req.method === 'GET') {
        const stored = objects.get(key);
        if (!stored) {
          res
            .writeHead(404, { 'Content-Type': 'application/xml' })
            .end('<Error><Code>NoSuchKey</Code></Error>');
          return;
        }
        res.writeHead(200, { 'Content-Type': stored.contentType }).end(stored.body);
        return;
      }

      if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204).end();
        return;
      }

      res.writeHead(405).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function driverFor(overrides: Partial<ConstructorParameters<typeof S3StorageDriver>[0]> = {}) {
  requests = [];
  return new S3StorageDriver({
    endpoint,
    region: 'auto',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    bucket: 'wandrly-media',
    forcePathStyle: true,
    ...overrides,
  });
}

describe('S3StorageDriver', () => {
  it('round-trips an object', async () => {
    const driver = driverFor();
    const body = Buffer.from('a photo of a mountain');

    const stored = await driver.put('trips/1/photo.jpg', body, 'image/jpeg');
    expect(stored).toEqual({
      key: 'trips/1/photo.jpg',
      size: body.byteLength,
      contentType: 'image/jpeg',
    });

    const fetched = await driver.get('trips/1/photo.jpg');
    expect(fetched?.toString()).toBe('a photo of a mountain');
  });

  it('signs requests — every call carries a SigV4 Authorization header', async () => {
    const driver = driverFor();
    await driver.put('signed.txt', Buffer.from('x'), 'text/plain');

    const auth = String(requests.at(-1)?.headers.authorization ?? '');
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(auth).toContain('Credential=test-access-key/');
    expect(auth).toContain('SignedHeaders=');
    expect(auth).toContain('Signature=');
  });

  it('uses path-style addressing, so the bucket is in the path not the host', async () => {
    const driver = driverFor();
    await driver.put('nested/key.bin', Buffer.from('x'), 'application/octet-stream');

    // The SDK appends `?x-id=PutObject`; only the path matters here.
    expect(pathOf(requests.at(-1)?.url)).toBe('/wandrly-media/nested/key.bin');
  });

  it('returns null for a missing object rather than throwing', async () => {
    const driver = driverFor();
    await expect(driver.get('does/not/exist.jpg')).resolves.toBeNull();
  });

  it('treats deleting a missing object as success', async () => {
    const driver = driverFor();
    await expect(driver.delete('never/existed.jpg')).resolves.toBeUndefined();
  });

  it('deletes an object that exists', async () => {
    const driver = driverFor();
    await driver.put('temp.jpg', Buffer.from('x'), 'image/jpeg');
    await driver.delete('temp.jpg');

    await expect(driver.get('temp.jpg')).resolves.toBeNull();
  });

  it('produces an expiring signed URL for a private bucket', async () => {
    const driver = driverFor();
    const url = await driver.urlFor('receipts/private.pdf', 900);

    expect(url).toContain('/wandrly-media/receipts/private.pdf');
    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('X-Amz-Expires=900');
    // Signing must not require a round trip — presigning is local.
    expect(requests).toHaveLength(0);
  });

  it('serves a public bucket directly, with no signature', async () => {
    const driver = driverFor({ publicBaseUrl: 'https://media.wandrly.app/' });
    const url = await driver.urlFor('trips/1/hero.jpg', 900);

    // Trailing slash on the base must not produce a double slash.
    expect(url).toBe('https://media.wandrly.app/trips/1/hero.jpg');
    expect(url).not.toContain('X-Amz-Signature');
  });
});
