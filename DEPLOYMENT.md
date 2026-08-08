# Deployment checklist

Everything that needs doing outside the codebase, in order. Nothing here has
been done for you — the backend has run entirely offline until now.

**Target:** ₹0/month recurring. Only the domain costs money, and that is optional.

---

## Before you start

| You will need | Cost | Required? |
|---|---|---|
| GitHub account (repo + Actions) | Free | **Yes** — ✅ done, `Prathameshp98/wandrly-backend` |
| Supabase account | Free tier | **Yes** — Postgres and Auth |
| Koyeb account | Free tier | **Yes** — API hosting |
| Cloudflare R2 **or** Backblaze B2 | Free tier | Recommended — 10 GB vs Supabase's 1 GB (step 2.6) |
| A domain | ~₹1,000/yr | No — Koyeb gives you a subdomain |
| Pexels API key | Free, no approval | No — image search is inert without it |
| Resend account | Free 3k/mo | No — emails are logged instead of sent |
| Sentry account | Free tier | No — errors go to logs instead |

**No credit card is required for any of the above.** Google Maps would need one,
which is exactly why it is not the default.

---

## Step 1 — Generate your secrets (do this first, offline)

```bash
# 32 bytes, hex. Encrypts booking details and payout identifiers.
openssl rand -hex 32     # → ENCRYPTION_KEY

# Shared secret for the GitHub Actions → /internal/cron endpoint.
openssl rand -hex 24     # → CRON_SECRET
```

> ⚠️ **`ENCRYPTION_KEY` is not recoverable.** It encrypts booking confirmations,
> PNRs, seat numbers, and payout details. It is stored nowhere else. Lose it and
> that data is permanently unreadable — everything else survives, but those
> fields are gone. Put it in a password manager **now**, before you continue.

Keep both somewhere safe. You will paste them into Koyeb in Step 4.

- [x] `ENCRYPTION_KEY` generated — 64 hex chars, validated against the env schema
- [x] `CRON_SECRET` generated — 48 hex chars
- [x] Both stored in the local `.env` (gitignored, verified)

> ⚠️ **`.env` is a working file, not a backup.** It lives on one machine and is
> excluded from git by design, so nothing else has a copy. `ENCRYPTION_KEY` is
> unrecoverable — if that machine is lost after real data has been encrypted
> with it, every booking confirmation, PNR, seat number and payout detail
> becomes permanently unreadable.
>
> Copy it somewhere durable before Step 4. Until anything is deployed there is
> no risk, and regenerating is two commands.

---

## Step 2 — Supabase (Postgres + Auth + Storage)

### 2.1 Create the project

1. Sign up at **supabase.com** → **New project**
2. **Region: Singapore (`ap-southeast-1`)** — this matters. Koyeb has no India
   region, so the API runs in Singapore, and app↔database latency is paid on
   *every query* while user↔app latency is paid once. Co-locate them.
3. Set a strong database password and save it — it appears in `DATABASE_URL`.

- [ ] Project created in Singapore
- [ ] Database password saved

### 2.2 Collect four values

Replace `<ref>` with your project ref — the subdomain in your dashboard URL
(`supabase.com/dashboard/project/<ref>`).

| Value | Where to click | Goes into |
|---|---|---|
| Connection string | **Connect** button in the top bar → **Session pooler** tab | `DATABASE_URL` |
| Project URL | Settings → **API Keys** — it is just `https://<ref>.supabase.co` | `SUPABASE_URL` |
| `service_role` key | Settings → **API Keys** → reveal `service_role` | `SUPABASE_SERVICE_KEY` |
| Token verification key | see the box below — **which one depends on your project** | `SUPABASE_JWKS_URL` *or* `SUPABASE_JWT_SECRET` |

> ⚠️ **Check which signing scheme your project uses before copying anything.**
> Supabase changed the default: projects created from 2025 onward sign tokens
> with **asymmetric keys** (ES256) and have **no JWT secret to copy**. Older
> projects use a shared HS256 secret. Run this — it needs no credentials:
>
> ```bash
> curl -s https://<ref>.supabase.co/auth/v1/.well-known/jwks.json
> ```
>
> | Result | Your project is | Set this |
> |---|---|---|
> | `{"keys":[{…}]}` — one or more keys | Asymmetric (ES256/RS256) | `SUPABASE_JWKS_URL=https://<ref>.supabase.co/auth/v1/.well-known/jwks.json` |
> | `{"keys":[]}` — empty | Legacy shared secret | `SUPABASE_JWT_SECRET=` from Settings → API Keys → JWT Settings |
>
> Set **one** of the two, not both. `SUPABASE_JWT_SECRET` takes precedence if
> both are present, so a stale secret alongside a JWKS URL silently sends every
> token down the wrong verification path.

> ⚠️ **Use the SESSION POOLER on port 5432.** There are three options in the
> dashboard and only one is correct:
>
> | Option | IPv4? | Mode | Use it? |
> |---|---|---|---|
> | **Session pooler** — `aws-N-<region>.pooler.supabase.com:5432` | ✅ | Session | ✅ **yes** |
> | Direct — `db.<ref>.supabase.co:5432` | ❌ **IPv6-only** | Session | Only if your host has IPv6 egress |
> | Transaction pooler — `…pooler…:6543` | ✅ | Transaction | ❌ breaks prepared statements |
>
> Supabase moved direct connections to **IPv6-only** in 2024 (verified: the
> direct host publishes an AAAA record and no A record). Koyeb does not document
> outbound IPv6, so relying on it is a gamble. The session pooler is IPv4 *and*
> session-mode, which is what a long-running server with real transactions and
> deferred constraint triggers needs.
>
> Note the pooler changes the username: **`postgres.<project-ref>`**, not
> `postgres`.
>
> ⚠️ **`service_role` bypasses row-level security.** It is a server-only secret.
> Never put it anywhere a browser can reach.

- [ ] All four values collected
- [ ] Using the **Session pooler** host on port **5432** (not the direct host, not 6543)
- [ ] JWKS endpoint checked, and **exactly one** of `SUPABASE_JWKS_URL` / `SUPABASE_JWT_SECRET` set

### 2.3 Enable extensions

**Database → Extensions**, enable:

- `citext` — case-insensitive email columns
- `pgcrypto` — UUID and hashing helpers

(Migration `0001_extensions.sql` also tries to create these, but the dashboard
is more reliable on a managed instance.)

- [ ] `citext` enabled
- [ ] `pgcrypto` enabled

### 2.4 Configure Auth

**Authentication → Providers**:

- Enable **Email** (password + magic link)
- Optionally enable **Google** and **Apple** — each needs its own OAuth app

**Authentication → URL Configuration**:

- Site URL: your frontend origin (or the Koyeb URL for now)
- Redirect URLs: add every frontend origin you will use

> The backend never creates users itself. It verifies Supabase's JWT and mirrors
> the identity into its own `users` table on first authenticated request, so
> there is no webhook to configure.

- [ ] Email provider enabled
- [ ] Redirect URLs set

### 2.5 Create the storage bucket

**Skip this if you are using R2 or B2 — see step 2.6, and pick one.**

**Storage → New bucket**:

- Name: `wandrly-media`
- **Private** (not public) — receipts and trip photos are not public objects.
  The API serves them through an authorization check.

- [ ] Bucket `wandrly-media` created, set to private

### 2.6 Choose where media lives

Supabase's free tier is the tightest constraint in this whole stack:

| | Storage | Egress / month | Card to sign up |
|---|---|---|---|
| Supabase Storage | **1 GB** | **5 GB** | No |
| Cloudflare R2 | 10 GB | **Free, unmetered** | **Yes** |
| Backblaze B2 | 10 GB | 30 GB (3× stored) | No |

Egress binds before storage does. A single trip with 200 photos at 2 MB is
400 MB; five people each loading that trip twice a month is 4 GB of egress
against Supabase's 5 GB — the app slows to a stop while the bucket is still
mostly empty.

The driver is **S3-compatible, not R2-specific**, so R2, B2, Wasabi and MinIO
all work with the same code. Switching later costs an endpoint and two keys.

**Cloudflare R2** — best free tier, but Cloudflare requires a card on file
before R2 activates. You are not charged inside the free allowance; if that is
not acceptable, use B2, which needs no card.

1. Cloudflare dashboard → **R2** → activate (card required)
2. **Create bucket** → `wandrly-media`
3. Bucket → **Settings** → confirm **Public Development URL** is **disabled**.
   If enabled, the `r2.dev` hostname serves every object to anyone with the
   URL — receipts included — no matter what the API does. It is a different
   hostname from the S3 endpoint, so `npm run storage:check` cannot see it.
4. **Manage R2 API Tokens** → create a token with **Object Read & Write**.
   Plain "Object Read" authenticates fine and fails only on the first upload,
   with a bare `AccessDenied` that looks like a wrong key.
5. Note the **Account ID** — the endpoint is
   `https://<account-id>.r2.cloudflarestorage.com`, region `auto`.
   Cloudflare displays the S3 URL **with the bucket appended**; drop that part,
   as the driver adds the bucket itself.

**Backblaze B2** — no card, slightly less egress headroom.

1. Sign up → **Buckets → Create a Bucket** → `wandrly-media`, private
2. **Application Keys → Add a New Application Key**, scoped to that bucket
3. The endpoint is shown on the bucket as `s3.<region>.backblazeb2.com` —
   prefix it with `https://` and set `S3_REGION` to that same region

Then set, in `.env` locally and in Koyeb for production:

```
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=<access key id>
S3_SECRET_ACCESS_KEY=<secret access key>
S3_REGION=auto            # B2: the region in your endpoint, e.g. us-west-004
S3_FORCE_PATH_STYLE=true
```

All three of endpoint, key id and secret must be set together — the app refuses
to start on a partial config rather than quietly falling back somewhere else.
Leave `S3_PUBLIC_BASE_URL` empty: the bucket stays private and reads go through
short-lived signed URLs, which is what receipts need.

**Then verify them before deploying:**

```bash
npm run storage:check
```

It does a real upload → download → signed URL → delete against the bucket, and
names the likely cause when a step fails. Credentials that parse are not
credentials that work: a token scoped to the wrong bucket or missing Object
Read & Write passes every startup check and fails on the first photo.

- [x] R2 bucket `wandrly-media` created — **done 2026-08-08**
- [x] Public Development URL disabled, verified: anonymous fetch returns 401
- [x] Token has Object Read & Write
- [x] All three `S3_*` credentials set, `npm run storage:check` green

---

## Step 3 — Run the migrations

From your machine, pointed at the new database:

```bash
cd wandrly-backend
DATABASE_URL="<your supabase URI>" npm run db:migrate
```

Expect: extensions → generated schema → invariants/triggers → "migrations complete".

Then verify the ledger's safety net actually installed:

```bash
psql "<your supabase URI>" -c "
  SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname;"
```

You should see **three** triggers in the `public` schema:
- `trg_shares_balanced`
- `trg_payments_balanced`
- `trg_activity_append_only`

Supabase adds its own triggers on `storage.buckets` and `storage.objects`;
filter on `nspname = 'public'` to see only ours.

If those three are missing, the database is not enforcing that expense splits
balance, and a bug could persist a wrong number. Do not proceed without them.

**The table count is the check that matters most.** 27 is correct; 25 means the
hand-written migrations after the generated schema did not run, and image search
and geocoding will fail at runtime on a missing relation. Migrations are
idempotent — re-running is safe and is the fix.

- [x] Migrations applied — **done 2026-08-08, against `jwanruyoqxdvakvheqvq`**
- [x] All three triggers present
- [x] Table count returns **27**
- [x] `citext` and `pgcrypto` present (created by `0001`, no manual step needed)
- [x] Re-run verified clean — migrations are idempotent

---

## Step 4 — Koyeb (the API)

### 4.1 Create the service

1. Sign up at **koyeb.com** → **Create Service** → **GitHub**
2. Connect the `wandrly-backend` repository, branch `main`
3. Builder: **Dockerfile** (one is in the repo root)
4. **Region: Singapore (`sin`)** — same region as Supabase
5. Instance: **Free**
6. Port: **8000**, protocol HTTP
7. Health check path: **`/health`**

- [ ] Service created in Singapore
- [ ] Port 8000, health check `/health`

### 4.2 Set environment variables

Mark everything except `NODE_ENV`, `PORT`, and `TRUST_PROXY` as **Secret**.

```
NODE_ENV=production
PORT=8000
LOG_LEVEL=info
TRUST_PROXY=1

DATABASE_URL=<from step 2.2>
DATABASE_POOL_MAX=5

# ONE of these two — see step 2.2. Asymmetric projects use the JWKS URL.
SUPABASE_JWKS_URL=https://<ref>.supabase.co/auth/v1/.well-known/jwks.json
# SUPABASE_JWT_SECRET=<only for legacy shared-secret projects>
SUPABASE_URL=<from step 2.2>
SUPABASE_SERVICE_KEY=<from step 2.2 — only if using Supabase Storage>

ENCRYPTION_KEY=<from step 1>
CRON_SECRET=<from step 1>

CORS_ORIGINS=<your frontend origin — comma-separated>
PUBLIC_BASE_URL=https://<your-koyeb-url>

STORAGE_BUCKET=wandrly-media
# Media storage — set these three if using R2 or B2 (step 2.6).
# Omit all three to fall back to Supabase Storage.
S3_ENDPOINT=<from step 2.6>
S3_ACCESS_KEY_ID=<from step 2.6>
S3_SECRET_ACCESS_KEY=<from step 2.6>
S3_REGION=auto
S3_FORCE_PATH_STYLE=true
```

**Only four of these are actually mandatory** — the app validates at boot and
tells you exactly what is missing:

| Variable | Why it blocks |
|---|---|
| `DATABASE_URL` | No database, no app |
| `ENCRYPTION_KEY` | Booking and payout fields cannot be written without it |
| `CRON_SECRET` | Scheduled work would be unauthenticated |
| `SUPABASE_JWT_SECRET` *(or `SUPABASE_JWKS_URL`)* | No way to verify a token |

Everything else has a sensible default or degrades. `SUPABASE_URL` and
`SUPABASE_SERVICE_KEY` are the exception worth calling out: they are optional in
development, but **production refuses to start without them** if media uploads
are used, because falling back to local disk would put user uploads on a
container filesystem that vanishes on redeploy.

> `CORS_ORIGINS` is configuration, not code, precisely because the frontend is
> not decided yet. Add origins as they appear. **Never use `*`.**
>
> The app validates every variable at boot and **refuses to start** on anything
> missing or malformed — a failed deploy with a clear error beats a service that
> starts and breaks on the first request that needs the value.

- [ ] All variables set, secrets marked as secret
- [ ] Deployed, health check passing

### 4.3 Migrations on future deploys

Migrations run as a **separate step**, never on boot — a failed migration should
not take the service down, and two instances must not race.

For now, run them from your machine after each deploy that includes a schema
change. If you want it automated later, add a Koyeb one-off job or a manual
GitHub Actions workflow that runs `npm run db:migrate`.

- [ ] Understood: migrations are a manual step for now

---

## Step 5 — GitHub Actions

> ✅ **Repository pushed** to `git@github.com:Prathameshp98/wandrly-backend.git`
> (branch `main`). Verified that `.env`, `.env.test`, `node_modules/`,
> `.storage/`, `dist/` and `coverage/` are excluded, and that no key, JWT, or
> live connection string appears in any tracked file.

### 5.1 Repository secrets

**Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `API_URL` | `https://<your-koyeb-url>` |
| `CRON_SECRET` | Same value as in Koyeb |

- [ ] Both secrets added

### 5.2 Why this matters more than it looks

`.github/workflows/cron.yml` drives all scheduled work: FX rates, purges,
notification digests, and **the nightly ledger reconciliation** — the job that
verifies every trip's balances still sum to zero.

It runs on GitHub's infrastructure rather than in-process **because a free Koyeb
instance can sleep**, and an in-process timer would silently stop firing. It also
keeps Koyeb and the Supabase free tier from idling out, which is a useful side
effect rather than the reason.

- [ ] CI workflow green on `main`
- [ ] Manually trigger the cron workflow once (**Actions → Scheduled tasks → Run
      workflow**) and confirm it returns 202

---

## Step 6 — Verify the deployment

```bash
API=https://<your-koyeb-url>

# 1. Health — should be {"status":"ok","database":true}
curl -s $API/health

# 2. Auth is enforced — should be 401
curl -s -o /dev/null -w '%{http_code}\n' $API/v1/trips

# 3. Unknown route returns the error envelope, not a stack trace
curl -s $API/nope

# 4. Cron endpoint rejects a wrong secret — should be 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/internal/cron/tick \
  -H 'Authorization: Bearer wrong' -H 'Content-Type: application/json' -d '{}'

# 5. Ledger reconciliation runs clean
curl -s -X POST $API/internal/cron/tick \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"group":"daily","inline":true}'
# → {"violations":[], ...}
```

Then create a real account through Supabase Auth and confirm an end-to-end
journey: create a trip → add a participant → log an expense → check balances sum
to zero.

- [ ] All five checks pass
- [ ] End-to-end journey works with a real Supabase user

> `/docs` (Swagger UI) is **disabled in production** by design. Use the committed
> `openapi.json` to generate a client.

---

## Step 7 — Optional services

Add these whenever you want. Each is inert until configured, and nothing breaks
without it.

### Pexels — image search
1. Get a free key at **pexels.com/api** (no approval, instant)
2. Set `PEXELS_API_KEY` in Koyeb

Without it: search returns an empty state; device uploads still work.

### Resend — email
1. Sign up at **resend.com**, verify a sending domain
2. Set `RESEND_API_KEY` and `EMAIL_FROM`

Without it: invite and notification emails are **logged, not sent**. Invites
still work if you pass the link manually, but this is the one optional service
that meaningfully limits the product — collaborators cannot be invited by email.

### Sentry — error tracking
1. Create a Node project at **sentry.io**
2. Set `SENTRY_DSN`

Without it: errors go to Koyeb logs only. Worth adding before real users, since
the nightly ledger-reconciliation alarm is the one thing you want to be paged for.

### Uptime monitoring
Point **UptimeRobot** or **BetterStack** (both free) at `/health`, 5-minute interval.

- [ ] Pexels (optional)
- [ ] Resend (recommended before real users)
- [ ] Sentry (recommended before real users)
- [ ] Uptime monitor

---

## Things that will bite you

**Supabase free tier pauses after ~7 days of inactivity.** The daily cron tick
touches the database, so this resolves itself — but verify it once rather than
assuming.

**Direct connection vs pooler.** If you see odd prepared-statement errors, check
you are on port 5432 and not 6543.

**IPv6 — confirmed, not hypothetical.** Supabase direct connections resolve to
IPv6 only. Verified for this project: `db.<ref>.supabase.co` has one AAAA record
and zero A records. If you use the direct host and Koyeb has no IPv6 egress you
get `ENETUNREACH`. Step 2.2 uses the IPv4 session pooler instead, which avoids
the question entirely.

**Free instances cold-start.** The first request after idle pays container start
plus a database connect. The cron tick keeps it warm during active periods.

**PDF export uses `pdfkit`, not Chromium** — deliberately, because Chromium needs
~500 MB–1 GB and would OOM a free instance. If PDFs look plainer than expected,
that is why, and it is documented in TECHNICAL_DESIGN §10.1.

**The known ~8% test flake** is test-infrastructure only and does not affect
runtime. See `IMPLEMENTATION_STATUS.md`.

---

## Backups

Supabase free tier includes daily backups. Add one more, because a backup living
inside the account it protects is not really a backup:

```bash
pg_dump "$DATABASE_URL" --no-owner --format=custom | gzip > wandrly-$(date +%F).dump.gz
```

Run it weekly (a GitHub Actions workflow can do this), store it elsewhere, and
**restore-test it once a quarter**. With a financial ledger in the database, an
untested backup is a hope, not a backup.

- [ ] Weekly dump configured
- [ ] One restore tested

---

## Running cost

| | Monthly |
|---|---|
| Koyeb free instance | ₹0 |
| Supabase free tier | ₹0 |
| Cloudflare R2 or Backblaze B2 free tier | ₹0 |
| GitHub Actions | ₹0 |
| Pexels / Resend / Sentry free tiers | ₹0 |
| **Total** | **₹0** |
| Domain (optional) | ~₹1,000/year |

R2 requires a card on file to activate, though nothing is charged inside the
free allowance. B2 requires no card. Neither is billed at this scale.

With media on R2 or B2, the binding limit becomes **Supabase's 500 MB database**
rather than storage — roughly 100k expense rows, far past where this app is
going. See TECHNICAL_DESIGN §18 for what to do when each limit is reached.
