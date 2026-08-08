/**
 * Mint a development access token.
 *
 * Paste the output into Swagger UI's Authorize box at /docs to exercise any
 * endpoint by hand. Same HS256 secret the API verifies, so no Supabase needed.
 *
 *   npm run token:dev            # Arjun, the seeded owner
 *   npm run token:dev -- <uuid>  # any user id
 */
import jwt from 'jsonwebtoken';
import { env } from '../src/platform/config/env';

const SEEDED_ARJUN = '00000000-0000-7000-8000-00000000a001';
const userId = process.argv[2] ?? SEEDED_ARJUN;

if (!env.SUPABASE_JWT_SECRET) {
  process.stderr.write(
    '\nSUPABASE_JWT_SECRET is not set, so there is no key to sign with.\n\n' +
      'A project on asymmetric Supabase keys verifies via SUPABASE_JWKS_URL and the\n' +
      'private half is Supabase’s — dev tokens cannot be minted against it. Set a\n' +
      'local HS256 secret in .env for development; it takes precedence over JWKS:\n\n' +
      '  SUPABASE_JWT_SECRET=$(openssl rand -hex 32)\n\n' +
      'Leave it out of production, where the JWKS URL is what verifies real tokens.\n\n',
  );
  process.exit(1);
}

const token = jwt.sign(
  { sub: userId, aud: env.JWT_AUDIENCE, email: `${userId}@wandrly.dev`, role: 'authenticated' },
  env.SUPABASE_JWT_SECRET,
  { expiresIn: '12h' },
);

process.stdout.write(`\nuser:  ${userId}\ntoken: ${token}\n\ncurl -H "Authorization: Bearer ${token}" http://localhost:8000/v1/me/balances\n\n`);
