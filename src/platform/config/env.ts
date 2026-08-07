/**
 * Environment configuration.
 *
 * TECHNICAL_DESIGN §12: parsed by Zod at boot, and the process REFUSES TO START
 * on a missing or malformed value. Failing here is loud and immediate; failing
 * lazily is a 3am incident on the first request that happens to need the value.
 */

import 'dotenv/config';
import { z } from 'zod';

const commaSeparated = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // ── Database ────────────────────────────────────────────────────
    DATABASE_URL: z.string().url(),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().max(20).default(5),

    // ── Auth (Supabase) ─────────────────────────────────────────────
    // HS256 shared secret is the documented default. Projects issuing
    // asymmetric tokens set SUPABASE_JWKS_URL instead.
    SUPABASE_JWT_SECRET: z.string().min(32).optional(),
    SUPABASE_JWKS_URL: z.string().url().optional(),
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_SERVICE_KEY: z.string().min(32).optional(),
    JWT_AUDIENCE: z.string().default('authenticated'),

    // ── Crypto ──────────────────────────────────────────────────────
    // 32 bytes, hex-encoded. Encrypts booking details and payout identifiers.
    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),

    // ── HTTP ────────────────────────────────────────────────────────
    CORS_ORIGINS: commaSeparated.default('http://localhost:5173'),
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:8000'),
    TRUST_PROXY: z.coerce.number().int().min(0).default(1),

    // ── Rate limiting ───────────────────────────────────────────────
    RATE_LIMIT_IP_PER_MIN: z.coerce.number().int().positive().default(600),
    RATE_LIMIT_USER_PER_MIN: z.coerce.number().int().positive().default(300),

    // ── Internal cron (§10.2) ───────────────────────────────────────
    CRON_SECRET: z.string().min(32),

    // ── Optional integrations. Absent ⇒ the feature degrades, never crashes ──
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().default('Wandrly <no-reply@wandrly.app>'),
    SENTRY_DSN: z.string().optional(),
    STORAGE_BUCKET: z.string().default('wandrly-media'),
    UNSPLASH_ACCESS_KEY: z.string().optional(),
    /** Free tier: 200 req/hour, 20k/month, no approval needed. */
    PEXELS_API_KEY: z.string().optional(),
    /**
     * Optional. Absent ⇒ OpenStreetMap/Nominatim, which needs no key and no
     * billing account. Google requires one; see TECHNICAL_DESIGN §11.2.
     */
    GOOGLE_MAPS_API_KEY: z.string().optional(),

    // ── Limits (configuration, not constants — PRD D-10) ────────────
    LIMIT_DAYS_PER_VARIANT: z.coerce.number().int().positive().default(90),
    LIMIT_VARIANTS_PER_TRIP: z.coerce.number().int().positive().default(8),
    LIMIT_BLOCKS_PER_DAY: z.coerce.number().int().positive().default(200),
    LIMIT_MEMBERS_PER_TRIP: z.coerce.number().int().positive().default(50),
    LIMIT_PARTICIPANTS_PER_TRIP: z.coerce.number().int().positive().default(50),
    LIMIT_EXPENSES_PER_TRIP: z.coerce.number().int().positive().default(2000),
    LIMIT_PHOTOS_PER_BLOCK: z.coerce.number().int().positive().default(20),
    LIMIT_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
    LIMIT_MEDIA_BYTES_PER_USER: z.coerce.number().int().positive().default(100 * 1024 * 1024),
  })
  .superRefine((value, ctx) => {
    if (!value.SUPABASE_JWT_SECRET && !value.SUPABASE_JWKS_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either SUPABASE_JWT_SECRET (HS256) or SUPABASE_JWKS_URL (RS256/ES256)',
        path: ['SUPABASE_JWT_SECRET'],
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/**
 * Treat a blank value as absent.
 *
 * `.env` files and hosting dashboards (Koyeb, GitHub Actions) both spell "not
 * configured" as an empty string, but Zod sees `''` as a present value — so
 * `SUPABASE_URL=` fails `.url()` instead of falling through to `.optional()`,
 * and the process exits at boot. Every optional integration here is meant to
 * degrade quietly when unset; stripping blanks makes that true for both
 * spellings of "unset".
 */
function withoutBlanks(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') result[key] = value;
  }
  return result;
}

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(withoutBlanks(process.env));

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    // Deliberately not using the logger: it depends on this module.
    process.stderr.write(`\nInvalid environment configuration:\n${issues}\n\n`);
    process.exit(1);
  }

  return parsed.data;
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDevelopment = env.NODE_ENV === 'development';

/** Per-trip and per-user ceilings, resolved once. TECHNICAL_DESIGN §10.4. */
export const limits = Object.freeze({
  daysPerVariant: env.LIMIT_DAYS_PER_VARIANT,
  variantsPerTrip: env.LIMIT_VARIANTS_PER_TRIP,
  blocksPerDay: env.LIMIT_BLOCKS_PER_DAY,
  membersPerTrip: env.LIMIT_MEMBERS_PER_TRIP,
  participantsPerTrip: env.LIMIT_PARTICIPANTS_PER_TRIP,
  expensesPerTrip: env.LIMIT_EXPENSES_PER_TRIP,
  photosPerBlock: env.LIMIT_PHOTOS_PER_BLOCK,
  uploadBytes: env.LIMIT_UPLOAD_BYTES,
  mediaBytesPerUser: env.LIMIT_MEDIA_BYTES_PER_USER,
});
