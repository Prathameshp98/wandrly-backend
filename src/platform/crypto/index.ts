/**
 * Cryptographic helpers.
 *
 * TECHNICAL_DESIGN §14. Everything here uses `node:crypto` — no native
 * dependencies, so the container stays small and the build stays portable.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

import { uuidv7 } from 'uuidv7';

import { env } from '../config/env';

// ── Identifiers ─────────────────────────────────────────────────────

/**
 * UUIDv7 — time-ordered, so it gives index locality without exposing a
 * sequential counter.
 *
 * Generated in application code rather than by Postgres: `pg_uuidv7` is not a
 * standard Supabase extension (§5.7), and having the id before the round-trip
 * simplifies building related rows inside one transaction.
 */
export const newId = (): string => uuidv7();

/** Opaque, unguessable public identifier. 128 bits, base64url (FR-NFR-SEC-04). */
export const newSlug = (): string => randomBytes(16).toString('base64url');

/** Single-use token for invites, unsubscribe links, and guest identities. */
export const newToken = (): string => randomBytes(32).toString('base64url');

export const newRequestId = (): string => randomUUID();

// ── Hashing ─────────────────────────────────────────────────────────

/** SHA-256, hex. Used for invite tokens so the DB never stores a usable link. */
export const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/** Stable hash of a request body, for idempotency-key reuse detection (§8.8). */
export const hashPayload = (value: unknown): string => sha256(JSON.stringify(value ?? null));

/**
 * Constant-time string comparison.
 *
 * Used for the cron shared secret and guest tokens. Length is compared first
 * because `timingSafeEqual` throws on a length mismatch.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ── Password hashing (share-link passwords only) ─────────────────────

const SCRYPT_KEYLEN = 64;

/**
 * scrypt via node:crypto. Chosen over argon2/bcrypt to avoid a native build
 * step in the container. This protects share-link passwords only — user
 * authentication is Supabase's responsibility, not ours.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return safeEqual(derived, expected);
}

// ── Authenticated encryption ────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const ENCRYPTION_PREFIX = 'enc:v1:';

const encryptionKey = Buffer.from(env.ENCRYPTION_KEY, 'hex');

/**
 * Encrypt sensitive field data at the application layer.
 *
 * Applied to booking details (FR-NFR-SEC-02) and payout identifiers
 * (FR-NFR-SEC-11). AES-256-GCM gives confidentiality and integrity, so
 * tampering is detected rather than silently decrypted to garbage.
 *
 * Output is prefixed and self-describing so a future key rotation or algorithm
 * change can be detected per value rather than requiring a big-bang migration.
 */
export function encryptField(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return (
    ENCRYPTION_PREFIX +
    [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':')
  );
}

export function decryptField(value: string): string {
  if (!isEncrypted(value)) return value;

  const [ivPart, tagPart, dataPart] = value.slice(ENCRYPTION_PREFIX.length).split(':');
  if (!ivPart || !tagPart || !dataPart) {
    throw new Error('decryptField: malformed ciphertext');
  }

  const decipher = createDecipheriv(ALGORITHM, encryptionKey, Buffer.from(ivPart, 'base64'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export const isEncrypted = (value: string): boolean => value.startsWith(ENCRYPTION_PREFIX);

/** Encrypt every value of a record. Used for the `booking` block section. */
export function encryptRecord(record: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, encryptField(value)]),
  );
}

export function decryptRecord(record: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, decryptField(value)]),
  );
}

// ── Signed tokens (unsubscribe links) ───────────────────────────────

/**
 * HMAC-signed payload for one-click unsubscribe (FR-NOTIF-09).
 * Lets a link flip a preference without a session, and is not guessable.
 */
export function signPayload(payload: string): string {
  const signature = createHmac('sha256', encryptionKey).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${signature}`;
}

export function verifySignedPayload(token: string): string | null {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;

  const payload = Buffer.from(encoded, 'base64url').toString('utf8');
  const expected = createHmac('sha256', encryptionKey).update(payload).digest('base64url');

  return safeEqual(signature, expected) ? payload : null;
}
