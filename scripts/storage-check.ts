/**
 * Prove the configured object storage actually works.
 *
 * Credentials that parse are not credentials that work: a token scoped to the
 * wrong bucket, a missing permission or a mistyped account id all fail at the
 * first upload rather than at boot. This does a real round trip — put, get,
 * signed URL, delete — so that failure happens here instead of the first time a
 * user adds a photo.
 *
 *   npm run storage:check
 */

import { env } from '../src/platform/config/env';
import { storage } from '../src/platform/storage/index';

const KEY = `_healthcheck/${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
const BODY = Buffer.from('wandrly storage check');

function ok(message: string): void {
  process.stdout.write(`  [32m✓[0m ${message}\n`);
}

function fail(message: string, error?: unknown): never {
  process.stdout.write(`  [31m✗[0m ${message}\n`);
  if (error instanceof Error) {
    process.stdout.write(`\n    ${error.message}\n`);
    // The provider's own error code is the fastest route to a diagnosis.
    const code = (error as { Code?: string; $metadata?: { httpStatusCode?: number } }).Code;
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode;
    if (code || status) {
      process.stdout.write(`    provider code: ${code ?? '—'}   http: ${status ?? '—'}\n`);
    }
    process.stdout.write(`\n${hintFor(error)}\n`);
  }
  process.exit(1);
}

function hintFor(error: Error): string {
  const text = `${error.message} ${(error as { Code?: string }).Code ?? ''}`;

  if (/InvalidAccessKeyId|SignatureDoesNotMatch|Unauthorized|401|403/i.test(text)) {
    return (
      '    Likely: wrong key pair, or the token lacks Object Read & Write.\n' +
      '    R2 → Manage R2 API Tokens → check the token’s permission and bucket scope.'
    );
  }
  if (/NoSuchBucket|404/i.test(text)) {
    return (
      `    Likely: the bucket "${env.STORAGE_BUCKET}" does not exist, or the token\n` +
      '    is scoped to a different one. Names are case-sensitive.'
    );
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) {
    return (
      '    Likely: S3_ENDPOINT is wrong. For R2 it is\n' +
      '    https://<account-id>.r2.cloudflarestorage.com — the account id, not the bucket.'
    );
  }
  // A wrong R2 account id resolves (the domain is a wildcard) and is then
  // rejected during the TLS handshake, so this is the mistyped-account symptom
  // rather than a certificate problem worth debugging.
  if (/EPROTO|handshake failure|SSL routines/i.test(text)) {
    return (
      '    Likely: the account id in S3_ENDPOINT is wrong. Cloudflare resolves any\n' +
      '    *.r2.cloudflarestorage.com name and rejects unknown accounts at TLS.\n' +
      '    Copy the id from R2 → Overview (right sidebar), not the bucket name.'
    );
  }
  if (/ECONNREFUSED/i.test(text)) {
    return '    Likely: nothing is listening on S3_ENDPOINT. Check the host and port.';
  }
  return '    Check S3_ENDPOINT, the key pair, and that the bucket exists.';
}

/**
 * Does the S3 endpoint serve this object without a signature?
 *
 * Only covers the endpoint we talk to. A bucket can also be exposed through a
 * separate hostname — R2's `r2.dev` development URL, or a custom domain — which
 * is invisible from the S3 API and has to be checked in the dashboard.
 */
async function isPubliclyReadable(signedUrl: string | null): Promise<boolean> {
  if (!signedUrl || env.S3_PUBLIC_BASE_URL) return false;

  try {
    const naked = signedUrl.split('?')[0];
    if (!naked) return false;
    return (await fetch(naked, { signal: AbortSignal.timeout(15_000) })).ok;
  } catch {
    return false;
  }
}

async function readsButCannotWrite(writeError: unknown): Promise<boolean> {
  const text = `${(writeError as Error)?.message ?? ''} ${(writeError as { Code?: string })?.Code ?? ''}`;
  if (!/AccessDenied|403/i.test(text)) return false;

  try {
    await storage.get('_probe_nonexistent');
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  process.stdout.write(`\nStorage driver: [1m${storage.name}[0m\n`);

  if (storage.name === 'disk') {
    process.stdout.write(
      '\n  Local disk — no cloud credentials configured.\n' +
        '  Set S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY to test R2 or B2.\n' +
        '  Production refuses to start in this state.\n\n',
    );
    return;
  }

  process.stdout.write(`Bucket: ${env.STORAGE_BUCKET}\n`);
  if (env.S3_ENDPOINT) process.stdout.write(`Endpoint: ${env.S3_ENDPOINT}\n`);
  process.stdout.write('\n');

  try {
    const stored = await storage.put(KEY, BODY, 'text/plain');
    ok(`upload (${stored.size} bytes)`);
  } catch (error) {
    // A denied write with a working read is a read-only token, not bad keys —
    // worth separating, because the fixes are different.
    if (await readsButCannotWrite(error)) {
      process.stdout.write('  \x1b[31m✗\x1b[0m upload — \x1b[1mtoken is read-only\x1b[0m\n');
      process.stdout.write(
        '\n    Reads succeed, writes are denied. The R2 API token was created\n' +
          '    with Object Read, not Object Read & Write.\n\n' +
          '    Cloudflare → R2 → Manage R2 API Tokens → edit the token (or create\n' +
          '    a new one) with "Object Read & Write", then update the key pair.\n\n',
      );
      process.exit(1);
    }
    fail('upload', error);
  }

  try {
    const fetched = await storage.get(KEY);
    if (!fetched) fail('download returned nothing — the object did not persist');
    if (!fetched.equals(BODY)) fail('download returned different bytes than were uploaded');
    ok('download, bytes match');
  } catch (error) {
    fail('download', error);
  }

  let signedUrl: string | null = null;
  try {
    signedUrl = await storage.urlFor(KEY, 300);
    const expiring = signedUrl.includes('X-Amz-Expires');
    ok(`${expiring ? 'signed' : 'public'} URL (${new URL(signedUrl).host})`);
  } catch (error) {
    fail('signed URL', error);
  }

  const exposed = await isPubliclyReadable(signedUrl);

  try {
    await storage.delete(KEY);
    const after = await storage.get(KEY);
    if (after) fail('delete did not remove the object');
    ok('delete');
  } catch (error) {
    fail('delete', error);
  }

  if (exposed) {
    process.stdout.write(
      '\n[31m[1mStorage works, but the bucket is PUBLIC.[0m\n' +
        '\n  An object was fetched with the signature stripped off, so anything\n' +
        '  uploaded — receipts included — is readable by anyone with the URL, and\n' +
        '  the expiry on our signed URLs means nothing.\n' +
        '\n  Cloudflare → R2 → your bucket → Settings → Public Development URL\n' +
        '  → disable. Then re-run this check.\n\n',
    );
    process.exit(1);
  }

  ok('S3 endpoint rejects unsigned reads');
  process.stdout.write(
    '\n  Not a proof of privacy: a public r2.dev URL or custom domain serves\n' +
      '  objects on a different hostname and is invisible from here. Confirm\n' +
      '  Public Development URL is disabled in the Cloudflare bucket settings.\n',
  );
  process.stdout.write('\n[32mStorage is working.[0m\n\n');
}

main().catch((error: unknown) => fail('unexpected failure', error));
