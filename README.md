# wandrly-backend

API for **Wandrly** — a collaborative trip-planning canvas with a group expense ledger.

Implements `TECHNICAL_DESIGN.md` v1.1 against `PRD.md` v1.1
(both in `Projects/Product/Wandrly/`).

- **Stack** — Node 22 · Express 5 · TypeScript · Drizzle · Postgres
- **Deploy target** — one Koyeb free instance + Supabase Postgres (Singapore)
- **Scale target** — ≤ 30 concurrent users, ₹0/month recurring
- **Frontend** — undecided by design. This API is frontend-agnostic; the
  committed `openapi.json` is the contract. See TECHNICAL_DESIGN §22.

---

## Quick start

```bash
npm install
cp .env.example .env          # then fill DATABASE_URL, ENCRYPTION_KEY, CRON_SECRET

# Postgres — either works
docker compose up -d          # or use a local/Homebrew Postgres

npm run db:generate           # regenerate migration from the Drizzle schema
npm run db:migrate            # extensions → schema → invariants/triggers
npm run dev                   # http://localhost:8000  ·  docs at /docs
```

Generate the two required secrets with:

```bash
openssl rand -hex 32   # ENCRYPTION_KEY  (exactly 32 bytes / 64 hex chars)
openssl rand -hex 24   # CRON_SECRET
```

> **`ENCRYPTION_KEY` is not recoverable.** It encrypts booking details and payout
> identifiers. Losing it means losing that data — it is stored nowhere else.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Watch-mode server (tsx) |
| `npm run build` / `start` | Compile to `dist/`, run compiled |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest — 199 tests |
| `npm run test:coverage` | Coverage, gated on the money + policy layers |
| `npm run db:generate` | Drizzle migration from schema changes |
| `npm run db:migrate` | Apply migrations (separate deploy step, never on boot) |
| `npm run openapi` | Regenerate the committed `openapi.json` |
| `npm run lint` | ESLint |

## Architecture

```
src/
├── money/          PURE money arithmetic — zero deps, exhaustively tested
├── contracts/      Zod schemas → validation + OpenAPI (the frontend contract)
├── platform/       cross-cutting, no business logic
│   ├── config/     env parsed by Zod at boot; refuses to start if invalid
│   ├── db/         Drizzle client, 25-table schema, BaseRepository, migrate
│   ├── policy/     table-driven authorization from PRD §8
│   ├── http/       validate · withTripAccess · errorHandler
│   ├── auth/       Supabase JWT verification
│   ├── realtime/   in-memory WebSocket hub + DeferredBroadcast
│   ├── jobs/       pg-boss workers + /internal/cron entrypoint
│   ├── crypto/     UUIDv7, AES-256-GCM field encryption, HMAC tokens
│   └── fx/         rate resolution (frozen per expense, never on read)
└── modules/        one folder per bounded context
    ├── ledger/     participants · expenses · balances · settlements
    ├── auth/       Supabase → local user mirror
    └── notifications/  audit log + notification fan-out
```

### Layering rules

1. **Routes** are three lines: delegate, serialise, respond. No logic, no SQL.
2. **Services** hold business rules and take injected repositories. They accept a
   `TripAccess` that only `withTripAccess` can produce, so the compiler enforces
   the authorization boundary — a route that forgets its guard cannot compile.
3. **Repositories** own SQL and accept an `Executor` (pool *or* transaction), so
   the same code runs inside and outside `withTransaction`.
4. **Presenters** are the only place that decides what leaves the server.
5. `src/money` imports nothing. Ever.

## Three things worth knowing before you change anything

### 1. Money is integers, always

Every monetary value is a `bigint` in the currency's **minor units**, and crosses
the wire as a **string** (`"580000"` = ₹5,800.00). `JSON.stringify` throws on
bigint and `Number` loses precision above 2^53.

Zero-decimal (JPY, KRW) and three-decimal (BHD, KWD) currencies are handled —
`convertMinor` accounts for the exponent shift, so ¥10,000 → ₹5,800 becomes
`580000` paise, not `5800`.

### 2. Shares are allocated twice, on purpose

An expense stores shares in **both** the expense currency and the trip's base
currency, allocated independently with the same weights.

Converting each share at read time is wrong: *the sum of rounded values is not
the rounded sum*, so `SUM(net) = 0` can break by one minor unit and silently
corrupt settle-up. `drizzle/0003_ledger_invariants.sql` asserts all four sums in
a **deferred constraint trigger**, so an unbalanced expense is physically
impossible to commit — verified:

```
ERROR: expense …c2: shares (9999) do not sum to expense total (10000)
ERROR: expense …c3: base-currency shares (579999) do not sum to base total (580000)
```

### 3. Authorization is table-driven and tested against the PRD

`src/platform/policy/actions.ts` is a transcription of PRD §8.
`policy.test.ts` re-transcribes that table independently and asserts every
role × action pair — 131 assertions. If the PRD changes, the test fails.
It already caught one real mismatch (Viewers may comment but not resolve).

`404` is returned for resources you cannot see, so the API is never an
existence oracle.

## What is implemented

| Area | State |
|---|---|
| Money layer (`allocate`, `simplify`, FX, currencies) | ✅ complete, 50 property/golden tests |
| Policy engine (4 roles × 33 actions) | ✅ complete, 131 tests |
| Database schema — all 25 tables | ✅ complete, migrated |
| Ledger invariant triggers + append-only audit | ✅ complete, verified against Postgres |
| Full-text search columns + GIN indexes | ✅ schema in place |
| Platform: config, db, errors, validation, auth, crypto, realtime, jobs | ✅ complete |
| **Ledger module** — participants, expenses, balances, settle-up, settlements, UPI hand-off | ✅ complete |
| Split resolution — all 5 methods, dual-currency | ✅ complete, 18 tests |
| OpenAPI generation + Swagger UI | ✅ 14 operations |
| Cron entrypoint + pg-boss workers | ✅ complete |
| Docker, CI, scheduled workflows | ✅ complete |

### Not yet implemented

See `IMPLEMENTATION_STATUS.md` for the ordered plan. In short: the ledger and its
whole supporting platform are done; trips/folders/canvas/collab/sharing/export
CRUD is next, and the schema and policy for all of it already exist.

## Deployment (Koyeb)

Build from the `Dockerfile` (target < 150 MB). Required runtime config:

```
DATABASE_URL  SUPABASE_JWT_SECRET  ENCRYPTION_KEY  CRON_SECRET
CORS_ORIGINS  PUBLIC_BASE_URL      TRUST_PROXY=1   PORT (injected)
```

- Health check: `GET /health` — returns 503 until Postgres is reachable.
- **Migrations run as a separate step after deploy**, never on boot: a failed
  migration should not take the service down, and two instances must not race.
- Set repository secrets `API_URL` and `CRON_SECRET` so
  `.github/workflows/cron.yml` can drive scheduled work. That tick also keeps
  Koyeb and the Supabase free tier from idling out.

## Notes on deliberate deviations

- **CommonJS, not ESM.** Matches the existing `safebox-backend` convention and
  keeps `drizzle-kit`'s loader working.
- **`pdfkit`, not headless Chromium**, for PDF export — Chromium needs
  ~500 MB–1 GB and will OOM a free instance (TECHNICAL_DESIGN §10.1). This is the
  one visible product-quality trade-off made for infrastructure reasons.
- **UUIDv7 generated in application code**, not by Postgres: `pg_uuidv7` is not a
  standard Supabase extension.
- **Supabase is managed infrastructure, not a framework.** We use its Postgres,
  Auth, and Storage; authorization is ours, in testable code, not RLS.
