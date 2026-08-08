# Implementation status

Honest accounting of what is built, what is not, and the order to continue in.
Tracks the phases in `TECHNICAL_DESIGN.md` §17.

**Verified working:** 388 tests (199 unit + 189 API) · `tsc --noEmit` and ESLint
clean · 25 tables migrated · invariant triggers reject bad data · auth guards
return 401/403/404 correctly · all 99 operations documented in `openapi.json`,
enforced by a test · **a full user journey — folder → trip → participant →
expense → balances → settle-up — completes over HTTP with no SQL.**

**Every module is now implemented.** What remains is deployment, a handful of
named gaps below, and the test flake.

⚠️ **The suite has a known ~8% flake.** See "Known shortcuts" below. It is test
infrastructure, not product code, but it is not fixed and should not be ignored.

---

## Complete

### Phase 0 — Foundation ✅
Repo, Express 5 app assembly with single-file middleware ordering, Zod-parsed env
that refuses to boot on bad config, pino with redaction of booking/payout/token
fields, error taxonomy with 20 codes, Dockerfile, docker-compose, CI, scheduled
workflows, graceful shutdown on SIGTERM.

### Phase 1 — Identity & authorization ✅
Supabase JWT verification (HS256 and JWKS), local user mirror (T-2), the
`validate()` middleware, `withTripAccess` as the single authorization seam, and
the policy engine with 131 tests asserting PRD §8 row for row.

### The money layer ✅ (built first, deliberately)
`allocate` (largest-remainder, deterministic tie-break, refund-symmetric),
`allocateBoth`, `allocateWithAdjustments`, `simplify` (≤ n−1 transfers),
`nettedPairwise`, currency exponents, `convertMinor` with exponent shift,
`parseRate`/`formatMinor`. 50 property-based and golden tests.

### Database ✅
All 25 tables. Deferred constraint triggers asserting four sums per expense.
Append-only audit log enforced by trigger. `search_tsv` generated columns + GIN
indexes. Optimistic-locking `version` columns. Deferred day-number uniqueness.

### Phase A — Test harness ✅
`test/support/{env,db,api,factories}.ts` — self-minted HS256 tokens (no Supabase
in the test loop), truncation-based isolation, and data factories. 24 API tests
covering the ledger end-to-end over real HTTP against real Postgres.
`npm run db:seed` loads the Kyoto dataset; `npm run token:dev` mints a token for
Swagger UI.

**Three real bugs found by writing these tests:**
1. `trips.main_variant_id` ↔ `variants.trip_id` is a circular FK that nothing
   could satisfy — now `DEFERRABLE INITIALLY DEFERRED`.
2. Zod runs `.refine()` even after `.regex()` fails, so a malformed
   `amountMinor` threw a raw `SyntaxError` → **500 instead of 400** on any bad
   amount. Fixed with a short-circuiting `moneyRefinement` helper.
3. `LOG_LEVEL=silent` was rejected by the env schema despite being a valid pino
   level.

### Phase B — Idempotency ✅
`Idempotency-Key` header on mutating routes. Keys are claimed atomically via
`ON CONFLICT DO NOTHING`, so exactly one concurrent request wins; retries replay
the stored response with `Idempotent-Replay: true`. Same key + different body →
409. Keys are scoped per user and purged after 24h.

Applied at six sites: trip creation and duplication (`trips.routes.ts:85,172`),
expense and settlement creation (`ledger.routes.ts:117,190`), variant creation
(`canvas.routes.ts:63`), and invites (`collab.routes.ts:113`). **Only the trip
routes have tests** — see `E2E_TEST_PLAN.md` Phase 7.

### Phase C — Trips & folders ✅
Trip CRUD, per-user pinning and ordering (`trip_user_state`, never a column on
the trip), archive/restore, soft delete/restore, deep-copy duplication, folders
with live counts, dashboard aggregates, and real readiness computation.

`POST /trips` builds the whole minimum graph in one transaction — trip, main
variant, owner membership, owner ledger participant, and one day per date — so
the ledger is reachable the moment a trip exists.

**FR-TRIP-14 implemented properly:** changing dates on a trip with existing days
returns `409 CONFLICT_DATE_CHANGE` with both day counts unless the caller states
a strategy (`SHIFT` / `TRUNCATE` / `EXTEND` / `KEEP_DAYS`). The server never
guesses, and never silently destroys days.

**Two real bugs found by the tests:**
1. Drizzle only auto-qualifies columns inside a raw `sql` template when the outer
   query has a JOIN. The folder-count subquery had none, so it emitted bare names
   that bound to the *subquery's* table — comparing `trips.folder_id` to
   `trips.id` and silently counting zero. Now hand-qualified.
2. `trips.main_variant_id` ↔ `variants.trip_id` needed the deferrable FK from
   Phase A before a trip and its variant could be created in one transaction.

### Phase D — Canvas ✅
Variants, days, blocks, and all six rich sections.

**Variant forking now actually exists.** Every variant owns its own day/block
tree; a fork deep-copies days, blocks, and sections, and the two then diverge
independently. The prototype shared one tree across all variants, so this — the
product's stated differentiator — had never worked anywhere. There is a test
asserting the original is untouched after the fork is edited.

Also corrects two prototype behaviours: duplicating a day inserts it immediately
*after* the source rather than at the end of the trip (FR-DAY-05), and blocks can
be reordered *within* a day, not only moved between days (FR-BLK-08).

Booking sections are encrypted before they reach the database and decrypted for
authorized readers — asserted by reading the raw JSONB and checking the
plaintext confirmation number is absent.

**Three bugs found while testing this phase:**
1. **A pool query inside a transaction.** `FxService` held the pool, so
   `createExpense` took a second connection while its transaction still held the
   first — a self-deadlock waiting to happen under real concurrency. FX now runs
   on the caller's executor.
2. **A leaked pool per test file.** Vitest's default `isolate: true` gives each
   file its own module registry and therefore its own `pg.Pool`; those pools
   outlived their file and their idle connections blocked the next file's
   `TRUNCATE` (which needs ACCESS EXCLUSIVE). Symptom: a ~20% chance of a random
   test hanging for the full timeout. Fixed with `isolate: false` + a single
   global teardown.
3. `createVariant` returned a bare row, so a fork's response reported
   `dayCount: 0` despite having copied three days.

### Phase E — Collaboration ✅
Members with presence, invites, comments, and the suggestion review queue.

**Invites** are token-based with the token stored **hashed** — a database read
never yields a usable join link. Accepting is the only route in the system that
runs outside `withTripAccess`, because the caller is not a member yet; the token
is the authorization, and the service additionally verifies it was addressed to
this user's email. Adversarially tested: a valid token held by the wrong user is
rejected, and they still cannot see the trip.

**Placeholder claiming works end to end** (FR-SPLIT-03): an invite can name a
placeholder participant, and accepting transfers that person's entire ledger
history onto the new account — verified by asserting the claimed balance is
still `-5000` and the ledger still sums to zero.

**Ownership transfer** clears-then-sets inside one transaction, so the
`one_owner_per_trip` partial unique index is never violated even momentarily.
A test confirms the previous owner is demoted rather than removed, and has
genuinely lost owner powers.

**Comments** thread exactly one level — a reply to a reply is refused rather
than silently flattened. **Suggestions** materialise a real block on accept,
attributed to the *proposer* rather than the reviewer.

Email degrades rather than failing: with no `RESEND_API_KEY` the message is
logged, so local development and CI need no provider and no network.

**A real production bug found while testing this phase:** the rate limiter was
mounted *before* `requireAuth`, so `req.ctx.userId` was always undefined and it
silently fell back to IP. The documented per-user limit did not exist, and
behind Koyeb's proxy every user on one NAT would have shared a bucket. Now split
into an IP guard before auth and the real per-user limiter after it, with a test
asserting two users get independent counters.

### Phase F — Sharing & exports ✅
Public share links with an unguessable 128-bit slug, optional password and
expiry, and a **server-rendered public page** with no client-side JavaScript and
no framework dependency — so a shared link keeps working regardless of what the
frontend becomes, or is rewritten into.

**Privacy is asserted by searching the raw payload**, not by trusting the shape:
`FR-SPLIT-40` (ledger) and `FR-SEC-09` (booking details) are verified by
confirming the secret values are absent from both the HTML and the JSON, with
every sharing toggle enabled. The JSON is additionally checked to carry no
`booking`, `cost`, or `sections` keys at all, so a future template cannot render
what it was never given.

Guest comments work with a returned guest token, so someone with no account can
delete their own comment but not anyone else's.

Exports: plain text, RFC 5545 calendar, PDF via **pdfkit** (not Chromium —
§10.1), and an expense CSV with one row per share. Booking details are excluded
unless explicitly requested.

### OpenAPI drift — fixed structurally ✅
The spec had fallen behind by **62 routes** across three phases, while being the
declared contract for the undecided frontend. All 76 operations are now
documented, and `test/api/openapi-coverage.test.ts` walks the live Express
router stack and fails on any undocumented public route. The drift cannot
silently recur.

### Phase G — Supporting surfaces ✅
**Packing list** — trip-scoped and collaborative, with per-item attribution of
who checked something off (FR-PANEL-07). Seeding a starter list is
non-destructive unless replacement is explicit.

**Trip notes** — shared and server-side, optimistically locked. The prototype
kept these in `localStorage`, so collaborators could not see them and they were
lost on a device change (FR-PANEL-10). A stale write now returns 409 with the
current text rather than clobbering someone.

**Notifications** — listing with unread count, mark-one/mark-all read, and the
per-trip activity feed. Self-actions are filtered at creation, so the unread
badge never counts your own edits. One-click unsubscribe is unauthenticated by
necessity — an email footer cannot require a session — and is protected by an
HMAC token that only flips one boolean.

**Search** — full-text over trips and blocks using the `search_tsv` generated
columns, plus name matching for people. Every query is scoped by membership
*before* ranking, so search can never become an existence oracle; block hits
carry variant and day ids so the client can deep-link and highlight
(FR-SRCH-06). Verified that a proper noun like "Kiyomizu-dera" is findable —
the reason the config is `simple` rather than `english`.

### Places, geocoding & maps ✅ (resolves PRD **D-03**)
`GET /v1/places/search` for location pickers, and `GET /v1/trips/:id/map`
returning every located block as a pin with its day number, plus a centre and
bounding box so the client can fit the viewport without guessing zoom.

**Rendering is the client's job** — MapLibre or Leaflet over free OSM tiles,
no key. The backend turns text into coordinates and keeps any key server-side.

**Default provider is OpenStreetMap/Nominatim: no API key, no billing account,
no card.** Google Maps is opt-in behind the same interface and completely inert
without `GOOGLE_MAPS_API_KEY`.

Google's universal $200 credit was retired in March 2025 — allowances are now
per-SKU and it requires an enabled billing account, which nothing else in this
stack does. At this scale Nominatim is sufficient, so the paid option stays
dormant.

Nominatim's usage policy is honoured properly: ~1 req/sec serialised, a
required `User-Agent`, and a week-long cache. Empty results are not cached, so
an outage is not pinned for seven days. A test asserts no key-shaped string ever
reaches a client.

### Third-party image search ✅
Users can search travel imagery from inside the picker rather than only
uploading from a device. **Pexels** is the provider, chosen after comparing
licence terms — see PRD **D-14** and TECHNICAL_DESIGN §11.1.

**The finding that decided it:** Unsplash *requires* hotlinking and forbids
caching; Pixabay *forbids* hotlinking and requires caching. Our pipeline
downloads and self-hosts, which is fine for Pexels and Pixabay but would breach
Unsplash's terms. Pexels also has no approval gate and a 4× higher starting
limit. A per-provider `attachMode` means adding Unsplash later needs no
re-architecture.

Search results are cached in Postgres for an hour, since 200 requests/hour would
not survive a search-as-you-type field. Empty results are deliberately not
cached. Imported bytes are re-validated by magic bytes — a provider is a third
party, not a trusted one. Attribution is non-nullable on provider assets and
included in every representation, because it is a licence obligation.

### Media ✅
Image uploads with a swappable `StorageDriver` — Supabase in production, local
disk everywhere else, so the whole pipeline is exercisable with no cloud account.
Production refuses to fall back to disk, because that would put uploads on an
ephemeral container filesystem that vanishes on redeploy.

**Two security properties, both tested by construction rather than by shape:**
- File type is decided by **magic bytes**, never the declared Content-Type. A
  PHP payload sent as `Content-Type: image/png` is rejected.
- **EXIF is stripped before anything is persisted**, so GPS from a holiday photo
  never reaches storage. The test plants a recognisable string in an APP1
  segment, uploads it, reads the stored bytes back, and asserts it is gone while
  the file is still a valid JPEG.

**Deliberate deviation from TECHNICAL_DESIGN §11:** uploads route *through* the
API rather than presigned direct-to-storage. Magic-byte validation and EXIF
stripping need the bytes anyway, so presigning would place an unvalidated,
GPS-bearing file in the bucket and sanitise it afterwards — a window that does
not need to exist. At ≤30 users a 10 MB cap through the container is a non-issue.
The driver interface supports either shape if volume ever changes that.

**Known limits, recorded as decisions not surprises:** no resizing or derivative
sizes (so FR-NFR-PERF-08 is unmet), no real blurhash (an average tone stands in),
and EXIF stripping covers JPEG only. All three are fixed by adding `sharp`, at
the cost of a much larger container — worth doing on a paid instance.

### Phase 8 — Ledger ✅ (built early: highest risk, hardest to retrofit)
Participants including account-less placeholders and reassignment-on-removal;
expenses with frozen FX and dual-currency allocation; all five split methods;
balances (server-computed, no rate arithmetic); settle-up with simplification
toggle and UPI deep links; settlements with confirm/void; cross-trip summary;
audit + notification fan-out; realtime broadcast after commit only.

---

## Not implemented

Schema, policy actions, contracts, and platform support **already exist** for all
of these — what is missing is repository/service/route code.

| Phase | Module | Notes |
|---|---|---|
| — | **Route contract test** | §4.4 promises a test walking the router stack to fail any mutating route missing `validate()`. Worth adding before the route count grows. |

---

## Next three things, in order

0. **Optional: a Pexels API key** (free, no approval: https://www.pexels.com/api/).
   Maps need nothing at all — Nominatim works out of the box.
   Original note: (free, no approval: https://www.pexels.com/api/) and
   set `PEXELS_API_KEY`. Without it image search returns an empty state and
   uploads still work, so nothing is blocked — but the feature is inert.
1. **Deploy (Phase H)** — Koyeb + Supabase. Needs a Supabase project and a Koyeb
   account; everything so far has run entirely offline. Once deployed, the
   frontend can start against a real API instead of localhost.
2. **Compare variants (FR-VAR-05).** Forking works; the side-by-side diff that
   makes it useful does not exist yet — the last unbuilt *product* behaviour.
3. **Public suggestions (FR-SHARE-06).** The toggle is stored and returned but
   no public route consumes it.

Every module from here ships with API tests, because the harness exists.

## Known shortcuts to revisit

- `LedgerService.pairwiseDebts` apportions each payer's share of each expense
  with integer division, so non-simplified mode can drift by a minor unit on
  multi-payer expenses. Simplified mode (the default) is exact. Fix by allocating
  pairwise obligations with `allocate()` rather than dividing in SQL.
- `ExpenseRepository.updateFields` and `replaceSplit` exist but no `PATCH
  /expenses/:id` route is wired yet, so expense editing (`FR-SPLIT-41`) is not
  reachable. The audit-on-edit requirement is written but untested.
- `TripRepository.findForUser` runs up to three list queries to locate one trip
  across views. Correct but wasteful; replace with a single targeted query when
  trip counts grow.
- ~~`POST /trips/:tripId/restore` lacks an ownership check~~ — **fixed**: the
  service now verifies ownership against the soft-deleted row and returns 404
  (not 403) for someone else's trip.
- ~~`CanvasService.deleteBlock` never flushed its broadcast~~ — **fixed**.
- ~~Comments are member-only~~ — **fixed**: guest commenting via a share link
  works, with a guest token scoping edit/delete rights.
- **Public suggestions (FR-SHARE-06) are not implemented.** The `allowSuggestions`
  toggle is stored and returned but no public route consumes it. Member
  suggestions work.
- **Known test flake, ~5% of full-suite runs** (re-measured: 3 failures in 69
  runs). Always the same shape: a row created moments earlier returns 404, in a
  different test each time. Never reproduces on a single file — only with
  several. Ruled out so far, with evidence: worker parallelism (files proven
  sequential by probe), pool size (unchanged at 20), per-test truncation
  (removed entirely), leaked pools (`isolate: true` + per-file close),
  non-atomic factories (now transactional), untracked background writes (now
  drained), and — added in the E2E test-plan pass — **job workers** (`startJobs`
  returns early under `isTest`), **idempotency background writes** (unreachable
  without an `Idempotency-Key` header), **fake-timer bleed across files** (no
  test installs them), and **responding before commit** (no route responds
  inside `withTransaction`).

  One occurrence is captured in full in `E2E_TEST_PLAN.md` Phase 0:
  `canvas.test.ts > blocks > soft-deletes and restores`, where `DELETE`
  404s on a block whose creation asserted 201 moments earlier. It narrows to two
  candidates — `loadTripAccess` returning null ("Trip not found") or
  `findBlockInTrip` returning null ("Block not found") — which are unrelated
  bugs that the suite could not previously distinguish.

  **`test/support/api.ts` now patches supertest's `_assertStatus`** to report
  the method, URL, error code, message, and `requestId` on every status
  mismatch, so the next occurrence identifies which. ~52 further runs under
  deliberate CPU and disk contention did not reproduce it.
- Variant comparison (FR-VAR-05) is not implemented — forking works, but the
  side-by-side diff does not exist.
- API tests cover the ledger only. Every module built from here adds its own.
- No system/E2E tests — deferred until the frontend exists, by decision.
  See `DEVELOPMENT_FLOW.md` §1 for why that is a different layer from the API
  tests above.
