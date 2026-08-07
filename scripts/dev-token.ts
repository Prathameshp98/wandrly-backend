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

const token = jwt.sign(
  { sub: userId, aud: env.JWT_AUDIENCE, email: `${userId}@wandrly.dev`, role: 'authenticated' },
  env.SUPABASE_JWT_SECRET!,
  { expiresIn: '12h' },
);

process.stdout.write(`\nuser:  ${userId}\ntoken: ${token}\n\ncurl -H "Authorization: Bearer ${token}" http://localhost:8000/v1/me/balances\n\n`);
