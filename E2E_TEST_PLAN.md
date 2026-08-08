# End-to-end test plan

Companion to `DEVELOPMENT_FLOW.md` §1, which defines five test layers. **This
plan is layer 2** — HTTP → Express → real Postgres → response — driven to the
point where it is a genuine end-to-end exercise of the product, not a set of
per-module unit checks wearing an HTTP costume.

Layer 5 (browser → frontend → API) stays deferred. There is no frontend. But
"no frontend" is not the same as "no end-to-end": every one of the nine critical
flows in PRD §15.2 is expressible over HTTP alone, and none of them exists as a
test today.

---

## Progress

| Phase | State | Tests | Bugs found |
|---|---|---|---|
| 0 — Suite health | ✅ | +3 | **2** — the flake, root-caused and fixed |
| 1 — Permission matrix | ✅ | +49 | **5** (2 cross-trip security holes) |
| 2 — Money & ledger | ✅ | +18 | **4** (settle-up lost money) |
| 3 — Canvas, variants, limits | ✅ | +14 | **3** + 1 vacuous test replaced |
| 4 — Collaboration & invites | ✅ | +9 | **3** (2 let you steal a ledger identity) |
| 5 — Sharing & privacy | ✅ | +15 | **3** |
| 6 — Media & third parties | ✅ | +16 | **3** (incl. stored XSS on the public page) |
| 7 — Cross-cutting | ✅ | +21 | **1** + 2 findings that were good news |
| 8 — The nine journeys | ✅ | +9 | **0** — every seam held |

**409 → 535 tests. 23 real bugs found, all 23 fixed and covered by tests. All eight phases complete.** Two let a caller touch
another trip's data, one silently lost money from the ledger, one broke the
idempotency guarantee — and the long-standing suite flake is root-caused and
gone (20/20 clean, from 3-in-15 immediately before).

---

## What this plan is reacting to

Measured on the current `main`, not assumed:

| Fact | Value |
|---|---|
| Tests passing | 409 (18 files, ~24s) |
| OpenAPI operations | 99 |
| Operations referenced by at least one API test | 91 |
| Operations referenced by **no** test | 8 |
| Cross-module journey tests | **0** |
| Realtime/WebSocket tests | **0** |
| `/internal/cron` tests | **0** |

The suite is strong per-module. Its weakness is structural, and there are four
kinds of it:

1. **No journey ever crosses a module boundary.** Every test builds its world
   with factories that write SQL directly, then exercises one module. So the
   handoffs — trip creation seeding the ledger, an invite acceptance minting a
   participant, a block deletion unlinking an expense — are the least-tested
   code in the system while being the most likely to break.
2. **`91/99` counts a reference, not a test.** A route touched once on its happy
   path is "covered" by that number and untested for authorization, edge cases,
   and failure modes. PRD §8 is a 27-row × 5-role matrix; nothing asserts it
   systematically at the HTTP layer.
3. **Some requirements have no implementation to test.** Found while writing
   this plan, listed in "Known gaps" below. A test plan that quietly skips them
   would be reporting a coverage number that hides them.
4. **`IMPLEMENTATION_STATUS.md` is stale in both directions.** It claims
   idempotency is not yet wired onto expenses and settlements — it is
   (`ledger.routes.ts:117,190`). It claims a live ~8% flake — Phase 0 measures
   whether that is still true. Both get corrected as phases complete.

---

## Known gaps — requirements with no route to test

These are findings, not test cases. Each phase states whether it tests the gap,
or records it and moves on. **Deciding which of these to build is the user's
call, not the test plan's** — the plan's job is to stop them being invisible.

| Requirement | State | Phase |
|---|---|---|
| `FR-SPLIT-41` — edit an expense | `updateFields`/`replaceSplit` exist; no `PATCH /expenses/:id` route. The audit-on-edit requirement is unreachable. | 2 |
| ~~`FR-SEC-03` — max 20 photos per block~~ | **Corrected in Phase 3.** The ceiling *did* exist — as a hardcoded `.max(20)` in the Zod schema, which is why `limits.photosPerBlock` appeared unused. Now wired to the config, as PRD D-10 requires. | 3 ✅ |
| `FR-VAR-05` — compare variants | No route. Forking works; the diff that makes it useful does not. | 3 |
| `FR-SHARE-06` — public suggestions | Toggle stored and returned; no public route consumes it. | 5 |
| `FR-COLLAB-06/07` — realtime co-editing | The WebSocket server attaches in `server.ts`, outside `buildApp()`, so supertest cannot reach it. Zero coverage. | 7 |
| `FR-SEC-05` — server-fetched link previews | **No such fetch exists.** `LinkSection` takes `url`, `host`, `title` and `desc` straight from the client, so there is no SSRF surface to sandbox — but every field is attacker-controlled input the public page renders. Phase 6 hardened the one that mattered. | 6 |
| `FR-SPLIT-47` — ledger at 500 expenses × 20 participants | No load assertion anywhere. | 2 |

---

## Phase order, and why it is this order

Ordered by **cost of finding the bug late**, not by module size. Money first
after the safety phases, because a wrong number in a shared ledger is the one
failure the PRD calls out as unrecoverable ("not a bug report, it is an argument
between friends"). Journeys last, because a journey test that fails when its
constituent modules are untested tells you nothing about where.

Each phase has an **exit criterion**. Issues found in a phase are fixed before
the next phase starts — that is the rule for this whole exercise. A phase that
finds a gap it cannot fix (a missing feature, not a bug) records it above and
exits on the rest.

---

### Phase 0 — Baseline hygiene and suite health ✅

Nothing below is trustworthy if the suite is not.

**Done:**

- `scripts/dev-token.ts` — kept, not discarded. It replaces a `!` non-null
  assertion with a real guard, turning `jsonwebtoken`'s "secretOrPrivateKey must
  have a value" into a message that names the cause and the fix. `env.ts` makes
  `SUPABASE_JWT_SECRET` genuinely optional (a JWKS project has no HS256 secret),
  so the unguarded path was reachable, not theoretical.
- Baseline green: 409 tests, 18 files, ~24s. `typecheck`, `lint`, `openapi`
  clean.

**The flake is real, and the documented rate is right.** Measured over 69
full-suite runs: **3 failures, ~4–6%**, consistent with the recorded ~8%.

One occurrence was captured in full:

```
FAIL test/api/canvas.test.ts > blocks > soft-deletes and restores
  expected 204 "No Content", got 404 "Not Found"
```

`scaffold()` creates the trip and block, both asserted `201`, and the very next
`DELETE .../blocks/:id` reports 404. That matches the recorded shape exactly —
"a row created moments earlier returns 404, in a different test each time".

**Not root-caused.** ~52 further runs, including deliberate CPU and disk
contention to widen the window, did not reproduce it. What the investigation
did rule out, with evidence:

- **Job workers** — `startJobs()` returns early under `isTest`, so no purge or
  reconciliation job runs during the suite. Nothing deletes rows in the
  background.
- **Idempotency background writes** — the only `background()` calls on this path
  live in `idempotency.ts`, and they are unreachable without an
  `Idempotency-Key` header, which `scaffold()` does not send.
- **Fake timers / global stubbing bleeding across files** — no test uses
  `vi.useFakeTimers` or `vi.setSystemTime`; the two `vi.mock` calls are
  module-scoped and reset by `isolate: true`.
- **Response-before-commit** — no route responds inside `withTransaction`, and
  `addBlock` re-reads the row through the pool after commit and would 500, not
  404, if it were not yet visible.

That leaves two candidates, both inside a `db` query returning zero rows for
data that demonstrably exists: `loadTripAccess` (→ "Trip not found") or
`findBlockInTrip` (→ "Block not found"). **These are different bugs and the
suite could not tell them apart** — which is why the next step was to fix the
diagnosis rather than keep guessing.

**Delivered instead of a blind fix:** `test/support/api.ts` now patches
supertest's `_assertStatus` so every status mismatch reports the method, URL,
error code, message, and `requestId` alongside the status. One patch, no call
sites touched, applies to all 409 existing tests and everything this plan adds:

```
expected 200 "OK", got 401 "Unauthorized"
  GET http://127.0.0.1:52601/v1/trips
  body: {"error":{"code":"AUTH_REQUIRED","message":"Authentication is required","requestId":"4880af…"}}
```

**Exit — met, with a caveat stated rather than hidden.** The suite is green and
its rate is measured, not assumed. The flake is *not* fixed. The judgement call
is to proceed: it is ~5%, it has never produced a false *pass*, and the phases
below roughly triple the number of API tests — which raises the per-run hit rate
and makes it far likelier to be caught now that a catch is informative. The
alternative — blocking all coverage work on a bug that survived 52 targeted
reproduction attempts — trades certain progress for uncertain progress.

**Standing instruction:** if any phase below sees an unexplained 404, capture
the full assertion output before re-running.

#### Resolved — root cause found, two bugs fixed

**The flake was two bugs, and the first one was in product code.**

**Bug 1 — idempotency answered a retry with 409.** `captureResponse` stored the
outgoing response with `background()` — fire-and-forget — and then responded.
That left a window in which the key was claimed but its `statusCode` was still
NULL, so a retry arriving inside it took the "original still in flight" branch
and got **409 instead of the replay it asked for**.

This was never test infrastructure, and the window is worst exactly where it
matters: a client whose connection is flaky enough to retry is *most* likely to
retry inside it. Idempotency exists so a retry is safe; answering it with a
conflict is the one thing it must never do. The write is now awaited before the
bytes go out, hooked on `res.end` (everything funnels through it — `json` →
`send` → `end`, and a 204 calls it directly), which also removed the separate
`finish` listener that fired *after* the 204 had already gone out.

**Bug 2 — the test harness opened a fresh TCP server per request.** This is the
one that produced the mystery 404s. `test/support/api.ts` passed a bare Express
app to supertest, and supertest's `serverAddress` does:

```js
if (!addr) this._server = app.listen(0);   // …and `end()` closes it again
```

So **every single request bound and released an ephemeral port** — several
thousand bind/close cycles per run. A request landing on a just-recycled port,
or written to a pooled keep-alive socket whose server had since closed, returns
a 404 that never touched Express — which is exactly the signature the
diagnostic finally showed:

```
POST /v1/trips
content-type: <none>
body: <empty body>
```

`content-type: <none>` is the tell. Express's `res.json()` always sets one, and
this app's error handler always ends in `res.status(...).json(payload)`. A
missing row would have produced `{"error":{"code":"NOT_FOUND",…}}`. No headers
and no body means no Express.

Fixed by binding **one listening server per test file** and handing supertest
that, so `app.address()` is never null, `_server` is never set, and nothing is
opened or closed per request.

**Measured, not assumed:** 3 failures in 15 runs immediately before the fix →
**0 in 20 after**, on otherwise identical code. Twenty clean runs is strong
evidence rather than proof — but it is paired with a mechanism that explains the
exact signature, which the two database-side theories never could.

**What this says about the original record.** `IMPLEMENTATION_STATUS` described
the flake as "test infrastructure, not product code" and as "a row created
moments earlier returns 404". Both were wrong, and both misdirected four earlier
fix attempts toward the database — pool size, truncation, leaked pools, atomic
factories. It was never a database bug. The thing that broke the deadlock was
not a better theory but **making the failure legible**: printing the response
body and content-type at the moment of failure turned a six-attempt mystery into
two obvious bugs.

#### Earlier update after Phase 2 — the diagnostic paid off, and the diagnosis changed

The flake was caught twice more with the patched assertion in place, and it is
**not** what the record says it is:

```
FAIL test/api/canvas.test.ts > block sections > survives a fork with booking details intact
  expected 201 "Created", got 404 "Not Found"
  POST /v1/trips/019fe079-…/variants
  body: <empty body>

FAIL test/api/permissions.test.ts > marks a single notification read …
  expected 201 "Created", got 404 "Not Found"
  POST /v1/trips/019fe079-…/suggestions
  body: <empty body>
```

**Both 404s have an empty body — and this API's error handler always emits a
JSON payload** (`errorHandler.ts` ends in `res.status(...).json(payload)`, with
no branch that sends an empty one). A missing row would produce
`{"error":{"code":"NOT_FOUND",…}}`. An empty body means the response *did not
come from the application*.

That retires both of the candidates Phase 0 was left with — `loadTripAccess`
returning null and `findBlockInTrip` returning null — because either would have
produced a JSON payload. It also explains why the bug never reproduced under
database-shaped pressure (pool contention, connection visibility, truncation):
it was never a database bug. The next avenue is the HTTP layer between supertest
and Express — a connection reused or torn down across the per-file app
instances, of which there are now 21.

The assertion patch now also reports `content-type`, so the next occurrence
distinguishes "no body" from "a body that failed to parse" without a rerun.

**Also fixed:** the patch was being applied once per test file. `isolate: true`
gives each file a fresh module registry but `supertest` resolves to one cached
instance, so each file wrapped the previous wrapper — a failure in the twelfth
file printed its diagnostic twelve times. Guarded with a symbol.

---

### Phase 1 — Permission matrix (PRD §8) ✅

**49 tests added** (`permissions.test.ts`, `route-contract.test.ts`). Suite: 409
→ 458. All 99 operations now reached. **Five real bugs found, all fixed.**

Two were security holes, and both had the same root cause — an authorization
check written against a bare id instead of against the trip in the URL:

1. **Cross-trip block restore.** `CanvasService.restoreBlock` looked the block
   up by id alone and then wrote `void access;`, discarding the caller's trip
   entirely. Anyone who could edit *any* trip could resurrect a soft-deleted
   block from *any other* trip. Now scoped through the day → variant → trip
   join, with the author check `deleteBlock` already had.
2. **Cross-trip expense restore.** `LedgerService.restoreExpense` passed the id
   straight to `BaseRepository.restore`, which filters on id only — so the same
   hole existed on financial records. Its sibling `deleteExpense` *did* check
   `expense.tripId !== access.tripId`; restore simply never got the same line.
   Added `findByIdIncludingDeleted`, since restore's subject is by definition
   invisible to `findById` and that is precisely why it was skipped.

3. **A Viewer could export the entire group ledger.** `GET
   /expenses/export.csv` was gated on `export:run`, which every role holds. PRD
   §8 has *two* export rows and they differ: "Export" admits everyone, "Export
   the expense report" denies a Viewer. The CSV query is trip-scoped with no
   participant filter, so it returned every share of every expense — directly
   contradicting "View the expense ledger: Viewer = own shares only", which
   `ledger.test.ts` already proved for the *list* endpoint. The rule was
   enforced in one place and bypassed in another. Now gated on `expense:view`.

4. **A Contributor could not delete their own expense.** The route gated on
   `expense:edit-any`, but the middleware has no resource with which to resolve
   `-any` down to `-own`, so `can()` returned false for a Contributor even on an
   expense they created — making PRD §8's "Own only" cell unreachable and
   `expense:edit-own` dead code. Fixed with the pattern blocks already use: a
   coarse route gate (`expense:create`), then the real check in the service with
   the expense's author in hand.

5. **The share link's slug was readable by every role.** `GET /share` was gated
   on `trip:view`. The slug *is* the capability to publish the trip, so handing
   it to a Viewer is the act PRD §8 restricts to Owner and Editor. Now
   `share:manage`. (Judgement call rather than a stated requirement — recorded
   as such.)

**Also delivered:** `route-contract.test.ts`, the §4.4 test
`IMPLEMENTATION_STATUS` listed as the last outstanding item. It walks the router
stack and fails any mutating route without `validate()`, plus a twin that fails
any `:tripId` route without an access guard. `isValidationMiddleware` already
existed and was used by nothing; the guard needed a matching marker.

It found one guardless route — `POST /trips/:tripId/restore` — which turned out
to be deliberate and correct (the trip is soft-deleted, so `loadTripAccess`
cannot see it; the service re-checks ownership). Exempted **with** a paired test
asserting the service-level check, since an exemption otherwise removes the only
pressure on that route.

**Two expectations of mine were wrong, and the code was right:** marking another
user's notification read, and reordering with a trip id you cannot see, both
return 204. Both are scoped away in SQL and have no cross-user effect. The tests
now assert that invariant rather than a status code I had guessed.

---

### Phase 1 — original scope

`policy.test.ts` has 131 tests asserting the policy *engine*. That is not the
same as asserting every *route* consults it. A route that forgets
`withTripAccess` entirely passes all 131.

- **A table-driven matrix test.** For each of PRD §8's 27 action rows, for each
  of OWNER / EDITOR / CONTRIBUTOR / VIEWER / non-member: one request, one
  expected status. Driven from a literal table so a reviewer can diff it against
  the PRD row for row.
- **The "own only" cells** — Contributors editing blocks, resolving comments,
  editing expenses. Each needs two cases: their own (allowed) and someone
  else's (denied).
- **Non-member discipline:** every trip-scoped route returns **404, not 403**,
  to a non-member. A 403 confirms the trip exists — an existence oracle.
- **The 8 unreferenced routes**, each with happy path + authz:
  `PATCH /variants/{id}` · `DELETE /comments/{id}` ·
  `POST /suggestions/{id}/withdraw` · `POST /notifications/{id}/read` ·
  `DELETE /packing/{id}` · `GET /share` · `PATCH /trips/{tripId}/folder` ·
  `POST /trips/reorder`
- **A route-contract test** — walk the Express router stack and fail any
  mutating route lacking `validate()`. `TECHNICAL_DESIGN` §4.4 promises this and
  `IMPLEMENTATION_STATUS` lists it as the one outstanding item. Its sibling
  (`openapi-coverage.test.ts`) already proves the pattern works.
- Archived-trip mutation is refused regardless of role; reads still work.

**Exit:** every §8 cell asserted at HTTP level; 99/99 operations reached.

---

### Phase 2 — Money and the ledger ✅

**18 tests added** (`ledger-money.test.ts`). Suite: 458 → 476. **Four real bugs
found, all fixed.**

1. **Pairwise settle-up lost money — and the recorded diagnosis was only half
   of it.** `IMPLEMENTATION_STATUS` blamed integer division in SQL, which was
   right but incomplete. Truncation was one cause; the deeper one is that
   apportioning each sharer's debt independently cannot work *even with exact
   rounding*. For the transfers to clear every balance, the debt matrix needs
   exact **row** sums (each sharer owes exactly their share) **and** exact
   **column** sums (each payer is owed exactly what they paid). Rounding rows in
   isolation gives only the first.

   Fixed by allocating against each payer's *remaining unallocated* amount
   rather than their original payment: because an expense's shares and payments
   both sum to its total, the last sharer consumes exactly what is left and both
   dimensions come out exact by construction. Refunds are handled by working in
   magnitudes and restoring the sign, since `allocate` requires non-negative
   weights.

   The test applies every proposed transfer to the balances and requires
   everyone to land on exactly zero — which is the property users actually care
   about, and which the previous shape failed by one minor unit.

2. **An expense could be linked to a block in another trip.** `createExpense`
   wrote `blockId: input.blockId ?? null` with no validation at all. FR-SPLIT-09
   requires links to target *this* trip's *main* variant; both halves are now
   enforced, and a foreign or non-main block id returns 404.

3. **FR-SPLIT-09's "becomes unlinked" half was unimplemented.** Deleting a block
   left every linked expense still pointing at it. The FK is `ON DELETE SET
   NULL`, but blocks are *soft*-deleted so it never fires — the unlink has to be
   explicit, and was not. Expenses now unlink inside the same transaction as the
   block's deletion. (The requirement's third clause, notifying the owner, is
   still not implemented — recorded below.)

4. Carried over from Phase 1's pattern: `deleteExpense` and `restoreExpense`
   gained their author checks here too, completing the "own only" cell.

**Verified rather than assumed:**

- **FR-SPLIT-47 is met with room to spare.** 500 expenses × 20 participants:
  balances in **6–13 ms**, settle-up in **8–14 ms**, against a 2000 ms ceiling.
  Simplification stayed within n−1 transfers and cleared every balance exactly.
- Zero-decimal (JPY) and three-decimal (BHD) currencies both round at the right
  digit and sum exactly.
- The exponent shift is right: ¥10,000 into an INR ledger is 580000 paise —
  not 5800, and not 58000000.
- A frozen rate really is frozen: moving JPY→INR 20% after the fact leaves
  recorded balances untouched.
- Largest-remainder is stable across repeated identical splits.
- A full-value refund returns every participant to their exact prior balance.

**A flake I introduced, and caught with the Phase 0 diagnostic.** The first
draft of the frozen-rate test moved `JPY→INR` to prove a recorded balance did
not follow it — and never moved it back. `fx_rates` is seeded once for the whole
run and never truncated, making it **the one piece of shared global state in the
suite**; every other table isolates by unique data. So `ledger.test.ts` began
failing intermittently, purely on file order, with `expected '696000' to be
'580000'`.

Worth stating plainly because it is the same shape as the flake Phase 0 could
not pin down — and this one was diagnosed in a single run, because the patched
assertion showed the *value* rather than just "one test failed". The test now
mutates KWD→INR, which nothing else reads, and `support/db.ts` documents the
constraint at the seeding function so the next person meets it before making the
same mistake.

**Found and recorded, not fixed — a documentation gap worth its own pass:**
**21 of 99 operations declare their 2xx response body as an empty `{}` schema**,
including the whole expense read path (`GET /expenses`, `POST /expenses`,
`GET /me/balances`, both settlement transitions), the dashboard, media, and all
four exports. `openapi-coverage.test.ts` proves every *route* is documented;
nothing proves its *response shape* is. With the frontend undecided and
`openapi.json` declared as the contract (TECHNICAL_DESIGN §22), a generated
client currently gets `any` for a fifth of the API. Some are legitimately
non-JSON (`.txt`, `.ics`, `.pdf`, `.csv`, media bytes) and want a corrected
content type rather than a schema; the rest have DTOs already defined and simply
unreferenced.

Also noted: `POST /expenses` answers with `{ id }` alone, so a client must
immediately re-read to see the shares, the frozen rate, and the base-currency
amount it just caused to be computed. Every other create route returns its full
DTO. Left alone as an API-shape decision rather than a bug.

---

### Phase 2 — original scope

The property tests in `src/money/` are excellent and cover the *algorithms*.
This phase covers the *ledger over HTTP*, which is where the algorithms meet
transactions, FX, and concurrent writers.

**Currency edge cases (`FR-SPLIT-22`)**
- Zero-decimal (JPY, KRW, VND): a ¥10,001 expense split 3 ways.
- Three-decimal (BHD, KWD): rounding at the third minor digit.
- An expense in a currency with a *different exponent* from the trip base — the
  exponent-shift path in `convertMinor`, over HTTP, with a frozen rate.
- Mixed-currency trip: balances presented in base currency only, never summing
  raw minor units across currencies.

**Splits (`FR-SPLIT-10`–`14`, `17`)**
- All five methods against the same expense; assert shares sum exactly.
- EXACT that overshoots *and* undershoots — both must name the delta.
- Percentages at 99.99% and 100.01%.
- SHARES with a zero weight, and with all-zero weights.
- ADJUSTMENT whose deltas exceed the total.
- Payer not among the split participants (`FR-SPLIT-12`) — explicitly normal.
- Multiple payers (`FR-SPLIT-13`, model-level) summing to the total, and not.
- A split with exactly one participant, and with every participant.
- Largest-remainder **stability**: the same odd split logged 10× hands the extra
  minor unit to the same participant every time, and across different expenses
  does not systematically favour the first-listed person (`FR-SPLIT-17`).

**Refunds (`FR-SPLIT-14`)**
- Negative expense reverses proportionally; balances return to prior state.
- Refund larger than the original.
- Refund on an expense whose participants have since been deactivated.

**Balances and settlement (`FR-SPLIT-23`–`32`)**
- `SUM(net) = 0` asserted after **every** mutation in every ledger test — the
  `FR-SPLIT-18` invariant, as a shared helper, not a per-test remembering.
- Settle-up graphs (golden, `FR-SPLIT-25`): a cycle; one payer for everyone;
  mutual debts; a participant with zero activity; already-settled.
- Simplified vs non-simplified on the same ledger. **`pairwiseDebts` is a known
  suspect** — `IMPLEMENTATION_STATUS` records that it apportions with integer
  division in SQL and can drift a minor unit on multi-payer expenses. Write the
  test that proves the drift, then fix it with `allocate()`.
- Settlement confirm → void → re-settle; void reasons are mandatory and
  settlements are never hard-deleted (`FR-SPLIT-31`).
- Settlement exceeding the debt; settlement between two participants with no
  mutual balance.
- Trip reaches "Settled" and reports it (`FR-SPLIT-32`).

**Participants (`FR-SPLIT-01`–`05`)**
- Removal blocked while non-zero (already tested) — plus removal *allowed* at
  exactly zero, and reassignment onto a participant who is themselves removed.
- A participant with history can never be hard-deleted (`FR-SPLIT-04`).
- Membership removal leaves the ledger identity intact (`FR-SPLIT-05`).

**Linked expenses (`FR-SPLIT-08`, `09`) — the differentiator, and untested**
- Expense linked to a block; planned-vs-actual variance is derivable.
- **Delete the linked block → the expense survives, unlinks, and balances are
  unchanged.** This is `FR-SPLIT-09` and PRD §15.2 flow 8.
- Demote the variant holding the linked block — same guarantee.
- Link to a block in a non-main variant → refused.

**Scale (`FR-SPLIT-47`)**
- 500 expenses × 20 participants; balances and settle-up return correctly and
  within a stated budget. Not a benchmark — a ceiling that fails loudly.

**Gap:** `FR-SPLIT-41` (expense editing) has no route. Test what exists; record
the gap.

**Exit:** invariant asserted after every ledger mutation; pairwise drift either
disproven or fixed.

---

### Phase 3 — Canvas, variants, days, blocks, limits ✅

**14 tests added** (`canvas-limits.test.ts`), one deleted. Suite: 452 → 465.

**A test that proved nothing.** `canvas.test.ts` had:

```ts
it('enforces the per-day block ceiling', async () => {
  // …
  expect(body.days[0].blocks.length).toBeLessThan(200);
});
```

It asserted that a day holding **one** block held fewer than 200 — which passes
just as happily if no ceiling exists at all. Replaced with one that fills a day
to `limits.blocksPerDay` and requires the next insert to be refused.

**A correction to my own Phase 0 note.** I recorded `FR-SEC-03`'s photo cap as
"the ceiling does not exist" because `limits.photosPerBlock` was read nowhere.
It *was* enforced — by a hardcoded `.max(20)` in the contract. So the ceiling
worked and the env var was decorative: changing `LIMIT_PHOTOS_PER_BLOCK` moved
nothing, contradicting PRD D-10's "limits are configuration, not constants".
The schema now reads the config, so the OpenAPI spec also reports the deployed
number rather than a literal.

**A concurrency defect — found, then fixed.** Filling days in parallel
collided on `days_variant_number_uq`: day numbers come from `count + 1` read
inside the transaction, so under READ COMMITTED two writers both read N and both
insert N+1. Nothing was ever corrupted — the constraint caught it — but the
loser got an opaque `DOMAIN_RULE_VIOLATION` naming a database index, and with
real-time co-editing (FR-COLLAB-06) two people pressing "Add a day" together is
ordinary use.

Initially recorded as known-and-pinned. Now fixed: a `SELECT … FOR UPDATE` row
lock on the variant serialises numbering for that variant only, so parallel
plans and other trips are unaffected and no retry loop is needed. Applied to
every path that assigns day numbers — append, duplicate, and the renumber after
a delete. Four concurrent appends now all return 201, and the ceiling test fills
in parallel batches again rather than one at a time.

**Also newly covered:** fork isolation in the *second* direction (editing the
original leaves the fork alone — a shared row fails exactly one of the two
directions, and only one was tested); forking a fork; block restore returning to
its original position rather than the end of the day; deleting the only day;
reorders naming a day twice or a day from another variant; moving a block
between variants of the same trip; every block type accepted and an unknown one
refused; and readiness as an exact percentage (33% for 1 of 3 bookable, with a
NOTE not diluting the denominator) plus 100% for a COMPLETED trip.

---

### Phase 3 — original scope

**Variants**
- Fork isolation both directions: edit the fork, original untouched; edit the
  original, fork untouched. (Only the first is currently tested.)
- Fork a fork. Fork an empty variant. Fork at the ceiling boundary
  (`FR-VAR-08`, 8) — the 8th succeeds, the 9th is refused.
- Promote → previous main retained, not deleted (`FR-VAR-06`); only OWNER.
- Delete main → refused until another is promoted (`FR-VAR-07`).
- Rename via the untested `PATCH /variants/{id}`.
- Public views, exports, and readiness follow **main only** (`FR-VAR-09`).

**Days**
- Duplicate inserts immediately after source and renumbers (`FR-DAY-05`).
- Delete renumbers contiguously (`FR-DAY-04`); delete the only day; delete the
  first and the last.
- Reorder: full permutation, partial (refused), duplicate ids, ids from another
  variant.
- Day ceiling (`LIMIT_DAYS_PER_VARIANT`) at the boundary.

**Blocks**
- Move within a day, across days, to index 0 and to the end (`FR-BLK-07/08`).
- Move into another trip → refused (tested); move into another *variant* of the
  same trip.
- Soft delete → restore → the exact prior position, not the end (`FR-BLK-09`).
- Block ceiling per day at the boundary.
- All 11 block types accepted; an unknown type refused.
- Bookable types drive readiness; non-bookable do not (`FR-BLK-10`,
  `FR-DASH-07`).

**Sections (`FR-SEC-*`)**
- Round-trip all six (tested) — plus: removing a section, replacing one,
  sending two of the same kind, and an unknown key (tested).
- Booking encryption at rest verified by reading raw JSONB (tested) — extend to
  survive duplicate, fork, promote, and export.
- **Photos: `limits.photosPerBlock` is enforced nowhere.** Write the test that
  attaches 21 photos and expects a refusal. It will fail. Then enforce it in
  `canvas.service.ts` alongside the other ceilings.

**Readiness (`FR-DASH-07`)**
- 0 bookable blocks → 0%, not a fabricated number (tested).
- Mixed booked/open → the exact rounded percentage.
- COMPLETED → always 100%.

**Gap:** `FR-VAR-05` (compare) has no route. Recorded.

**Exit:** every ceiling in `limits` asserted at its boundary, or recorded as
unenforced.

---

### Phase 4 — Collaboration and invite security ✅

**9 tests added** (`invites-security.test.ts`). Suite: 465 → 474. **Three real
bugs, two of them serious.**

`claimsParticipantId` is the field that decides **whose ledger history the
accepter inherits**. It arrives from the client and was stored verbatim — never
checked against the trip, never checked to be an unclaimed placeholder. That was
two attacks at once:

1. **Cross-trip identity theft.** An Editor of trip A could send an invite
   naming a participant id from trip B. On accept, that row's `userId` was
   overwritten — handing the accepter someone else's ledger identity, balances
   and all, on a trip the sender cannot even see. `POST /invites` returned 201.

2. **Same-trip identity theft.** The id could name a participant who already
   has an account. Accepting overwrote their `userId`, `claimedAt` and
   `displayName`, transferring an existing member's entire financial history to
   whoever redeemed the link. Also 201.

Both now go through one guard, applied **twice**: when the invite is written,
and again inside the accept transaction — because the placeholder can be claimed
by someone else in between, and redemption is the moment the money actually
moves. "Not on this trip" answers 404 rather than 422, so an invite cannot be
used to probe for participant ids on trips the sender has no access to.

3. **The member ceiling was advisory.** `sendInvites` compared
   `members + emails` against `LIMIT_MEMBERS_PER_TRIP` while counting only
   *accepted* members, so nothing stopped 49 invites, then 49 more, then
   everyone accepting. Pending invites now count at send time, and the
   authoritative check moved to accept time — the only point at which the
   membership count is final.

Also fixed: transferring ownership **to yourself** returned 204. The
clear-then-set leaves the invariant intact, so it is a no-op — but it wrote an
activity event claiming a handover that never happened. Now refused, matching
the existing refusal to change your own role.

**Two stated security properties had no test and now do:** that a database read
never yields a usable join link (the stored value is a 64-hex digest and never
appears in any response), and that every well-formed unknown token is answered
identically, so a caller cannot probe which invites exist.

**One of my assertions was too strict.** I first required malformed tokens to be
indistinguishable from unknown ones. They are not — a malformed token is refused
by the schema (400) and an unknown one by the lookup (404). That leaks nothing:
it says "that is not a token shape", not "no such token". The test now compares
only well-formed guesses, which is the property that actually matters.

---

### Phase 4 — original scope

The invite path is the only route in the system that runs outside
`withTripAccess`, which makes it the highest-value adversarial target.

- Token is stored **hashed** — assert a raw DB read yields nothing usable.
- Valid token, wrong user (tested) — plus: wrong user then cannot see the trip
  by any other route.
- Expired, revoked, already-accepted, malformed, and empty tokens — all
  indistinguishable to the caller.
- Invite to an existing member; invite to yourself; invite an email that later
  changes.
- Accepting mints both a membership **and** a ledger participant, in one
  transaction.
- **Placeholder claiming (`FR-SPLIT-03`)**: full ledger history transfers with
  balances unchanged (tested) — plus claiming a placeholder that has already
  been claimed, and one with settlements attached.
- Member ceiling (`LIMIT_MEMBERS_PER_TRIP`) counts pending invites.
- **Ownership transfer**: one owner at all times (tested) — plus transfer to a
  non-member (refused), to yourself, and two concurrent transfers.
- Comments: one level of threading enforced (tested); reply to a deleted parent;
  `DELETE /comments/{id}` (untested); resolve/unresolve; @-mention notification.
- Suggestions: withdraw (untested); review twice (tested); accept into a deleted
  day; the proposer, not the reviewer, is the block's author (tested).

**Exit:** every invite failure mode returns an indistinguishable response.

---

### Phase 5 — Sharing, the public surface, and privacy ✅

**15 tests added** (`public-privacy.test.ts`). Suite: 474 → 489. **Three real
bugs.**

The privacy core held up. A fixture plants four recognisable secrets — a booking
confirmation, a seat number, a stored UPI id, and an expense description — and
every public representation is searched for all four. Nothing leaked, with every
toggle on, and also when the link points at a non-main variant. The JSON is
additionally checked to carry no `booking`, `cost`, `sections`, `expenses` or
`balances` key at all, so a future template cannot render what it never
received. `FR-SPLIT-40` and `FR-SEC-09` hold.

What did not hold:

1. **A guest token outlived the link that issued it.** `deleteGuestComment`
   looked the share link up by slug and checked only that it existed — never
   `isEnabled`, never `expiresAt`. So after an owner switched sharing off,
   *posting* a guest comment correctly 404'd while *deleting* one still returned
   204. A guest token is a capability scoped to one link; revoking the link has
   to revoke the token with it.

2. **The public JSON and the public HTML disagreed about a password.** The HTML
   route catches `ForbiddenError` and answers 401 with the password form. Its
   JSON twin let the error fall through to the handler, which maps it to **403**
   — telling a client "never" where the truth is "supply the password". Same
   condition, same link, two different meanings. The JSON route now answers 401
   with a `PASSWORD_REQUIRED` code.

3. **Trip-level guest comments were accepted and then never shown.**
   `renderPublicPage` groups comments by `blockId` and dropped any without one
   (`if (!comment.blockId) continue`). But `blockId` is nullish in the contract
   and the API happily accepts a trip-level comment — so a visitor got a 201 and
   then watched their comment never appear, which is worse than either accepting
   or refusing it cleanly. They now render in a "Notes from visitors" section.

**Also verified rather than assumed:** disabling a link takes effect
immediately and re-enabling restores it; revoking and re-sharing mints a
*different* slug rather than reusing the old one; an expired link is
byte-for-byte identical to an invented slug, so it cannot confirm a trip exists;
the password is never echoed into the page it protects (it travels as a query
parameter, so it is already in the viewer's history — rendering it would put it
in every screenshot too); markup in a trip title is escaped while a 4-byte emoji
and RTL text survive intact; exports name their variant (`FR-EXP-07`), default
booking details off, produce CRLF-terminated `VCALENDAR` with balanced
`VEVENT`s, and quote a comma inside a CSV description rather than splitting the
row.

**Worth a decision, not a bug:** the share password travels as `?password=…`.
That puts it in browser history, server access logs, and any `Referer` sent to
the third-party links the page renders. A POST-and-cookie exchange would avoid
all three. Recorded rather than changed, since it alters the public URL contract.

**One of my assertions was wrong.** I first required the escaped guest comment
to be *absent* from the page. It should be present and escaped — dropping it
silently is the bug I had just fixed elsewhere. Corrected to assert
`&lt;img src=x` appears.

---

### Phase 5 — original scope

Privacy assertions here search the **raw payload** for the secret, rather than
checking the response shape. A shape assertion passes when a future template
starts rendering a field it was never meant to have.

- Ledger and booking details absent from HTML **and** JSON with every toggle on
  (tested) — extend to: the `.ics`, the `.txt`, and the PDF byte stream.
- Password-protected link: wrong password, no password, correct password;
  brute-force is rate-limited.
- Expiry: before, at, and after; disabled and revoked links 404
  indistinguishably from a made-up slug (tested).
- Rotating a link invalidates the old slug immediately (`FR-SHARE-03`).
- Guest comments: enabled/disabled (tested); a guest token deletes only its own
  comment (tested); an expired share link invalidates the guest token.
- OpenGraph tags correct and user content escaped (tested) — plus a title
  containing markup, RTL text, and a 4-byte emoji.
- Exports: booking details **off by default**, on by explicit request
  (`FR-EXP-02`, tested); the active variant's name is printed (`FR-EXP-07`);
  untimed blocks become all-day VEVENTs (`FR-EXP-05`); CSV is one row per share
  (tested) and parses as valid CSV with a quoted comma in a description.

**Gap:** `FR-SHARE-06` (public suggestions) has no route. Recorded.

**Exit:** no secret value appears in any public representation, proven by
substring search across all five output formats.

---

### Phase 6 — Media and third-party boundaries ✅

**16 tests added** (`media-boundaries.test.ts`). Suite: 489 → 505. **Three real
bugs, one of them the most serious finding so far.**

1. **Stored XSS on the public share page.** `LinkSection.url` was
   `z.string().url()`, and Zod defers to `new URL()` — which considers
   `javascript:alert(1)`, `data:text/html,…` and `vbscript:` perfectly
   well-formed. The public page renders `<a href="${esc(url)}">`, and `esc`
   does nothing to a scheme because those payloads contain no markup.

   So any Contributor could store one, the owner would never see it in their own
   client, and it would ship as a clickable script to every **unauthenticated**
   visitor of the share link — which is the acquisition channel, passed around
   in group chats. Confirmed with a request that returned 201.

   Fixed at both ends: the contract now refuses any scheme but http(s), and the
   renderer checks again before emitting an href, degrading a bad link to plain
   text. Both were needed — the contract protects new rows, but anything written
   before the fix is still in the database and still ships to strangers.

2. **An oversized upload was a 500.** `raw({ limit })` rejects the body before
   the route sees it, and body-parser's `entity.too.large` had no mapping in the
   error handler. A user attaching a large photo got an opaque server error
   instead of being told the file is too big. Now 413.

3. **Attribution was omitted rather than null.** A device upload returned no
   `attribution`/`attributionUrl`/`provider` keys at all, so a client could not
   distinguish "no credit required" from "the field is missing". FR-MEDIA-03 is
   a licence obligation, so those keys are now always present, explicitly null.

**A requirement that turns out not to exist.** `FR-SEC-05` specifies the server
fetching OpenGraph metadata and sandboxing the fetch against SSRF. There is no
such fetch — the client supplies `url`, `host`, `title` and `desc`. That is
*better* for SSRF (no surface at all) and worse for trust (all four fields are
attacker-controlled). Recorded above rather than built.

**Verified rather than assumed:** a GIF/HTML polyglot is either refused or
stored as an image served with `nosniff` and an `image/*` content type; a
PNG-signature-only body is refused; stored bytes carry `nosniff` and a
`Content-Disposition`; quota is per user, frees on delete, and does not leak
across users; image search degrades to an empty state with no provider key while
upload keeps working; another user's bytes 404 rather than 403 on read, delete
and patch alike.

**A limit pinned by a test rather than a comment:** a PNG round-trips
byte-identical, because EXIF stripping covers JPEG only. If `sharp` is ever
added, that test is the one that should change.

---

### Phase 6 — original scope

- Magic bytes decide type, never `Content-Type` (tested) — extend to a
  polyglot file valid as both GIF and HTML, and a zero-byte file.
- EXIF stripped before persistence, verified by reading stored bytes (tested).
  Note the known limit: JPEG only. Assert PNG/WebP pass through unchanged so
  the limit is documented by a test rather than by a comment.
- Per-upload and per-user quota at the boundary; quota freed on delete (tested).
- `404`, not `403`, for another user's bytes (tested).
- `nosniff` on served bytes (tested); `Content-Disposition` on downloads.
- Provider degradation: with no `PEXELS_API_KEY`, search returns an empty state
  and upload still works (`FR-MEDIA-07`).
- Attribution is non-nullable on provider assets and present in **every**
  representation (`FR-MEDIA-03`) — a licence obligation, so assert it on the
  block payload, the canvas payload, the public page, and the export.
- Re-attaching the same provider photo reuses the asset (`FR-MEDIA-05`, tested).
- Imported bytes re-validated by magic bytes (tested).
- **SSRF**: `FR-SEC-05` specifies the link-preview fetch is sandboxed. Establish
  whether that fetch exists; if it does, test `localhost`, `169.254.169.254`,
  and a redirect chain ending at a private address.

**Exit:** every byte-accepting path validates by content, not by claim.

---

### Phase 7 — Cross-cutting ✅

**21 tests added** (`cross-cutting.test.ts`). Suite: 505 → 526. **One real bug,
and two findings that turned out to be good news.**

**The bug: malformed JSON was a 500.** `express.json()` rejects a broken body
with `type: 'entity.parse.failed'`, which had no mapping — so a client sending
`{"destination": "Kyoto"` (one brace short) got `INTERNAL`. That tells the
caller to retry something that will never work. Now 400 `VALIDATION_FAILED`,
alongside `encoding.unsupported`. This is the same class as the oversized-upload
500 fixed in Phase 6: **body-parser errors bypass every route, so nothing in the
module layer could ever have caught them.** Both are now handled in one place.

**Good news 1: the ledger cannot be corrupted, even deliberately.** The obvious
way to test reconciliation is to knock a ledger out of balance and watch it get
caught. That turns out to be impossible — the deferred constraint trigger
rejects the write outright, so a residual never reaches the table. The test now
asserts *that*, which is a stronger property than reconciliation noticing after
the fact, and it reframes the cron sweep as defence-in-depth rather than the
only thing standing between the ledger and a wrong number.

**Good news 2: the scheduled workflow is correct.** A bodyless POST to
`/internal/cron/tick` is refused with 400 rather than defaulting to `daily`. I
checked `.github/workflows/cron.yml` before assuming that was a bug — it posts
`-d '{"group":"…"}'`, so the deployed caller is fine. Pinned by a test, so a
future edit that drops the `-d` fails loudly instead of running the wrong group.

**Newly covered, having had none:**

- **`/internal/cron` had zero tests.** Now: a missing, wrong, and malformed
  secret are all refused; the secret works by `X-Cron-Secret` *and* by bearer
  token; each of the three documented groups is accepted; an undocumented group
  is refused; `inline: true` runs reconciliation and reports; and the endpoint
  is rate limited at 20/minute, far tighter than the signed-in API.
- **Idempotency on the five routes that had none.** Expenses replay instead of
  double-charging; settlements replay and refuse the same key with different
  money (`CONFLICT_IDEMPOTENCY_MISMATCH`); a variant does not fork twice; keys
  stay scoped per user.
- **Optimistic locking on days**, including that a stale write leaves the
  winning edit intact rather than clobbering it, and that every accepted write
  advances the version so a retry cannot succeed twice.
- **Concurrency against one ledger:** six simultaneous expense creations all
  succeed and `SUM(net) = 0` still holds; a settle-up read racing an expense
  write leaves the invariant intact.
- **The error taxonomy:** every error carries a `code`, a `message` and a
  `requestId`; a malformed `amountMinor` is 400 not the 500 it once was (the
  regression test for the `moneyRefinement` fix); unknown routes and unsupported
  methods answer in the same shape.
- **`/health`** reports database reachability without authentication.

---

### Phase 7 — original scope

**Idempotency (§8.8)** — applied at six sites; tested at one.
- Replay returns the stored response with `Idempotent-Replay: true` (tested on
  trips) — repeat for expenses, settlements, variants, and invites.
- Same key + different body → 409 (tested on trips) — repeat for the ledger,
  where it matters most.
- Two genuinely concurrent requests with one key → exactly one wins.
- Key scoped per user (tested); key on a route that has no `idempotent()`.

**Optimistic locking (§5.9)**
- Stale version → 409 carrying current state, on every versioned entity: trip
  (tested), block (tested), notes (tested), day, variant, expense.

**Concurrency**
- Two simultaneous expense creations on one trip — both persist, invariant holds.
- Simultaneous edits to the same expense (`FR-SPLIT-43`).
- Simultaneous day reorders.
- Concurrent settle-up while an expense is being added.

**Error taxonomy (§8.3)**
- Each of the 20 error codes reachable and correctly shaped.
- Malformed JSON, wrong content-type, oversized body, unknown route,
  unsupported method.
- A malformed `amountMinor` returns **400, not 500** — the regression test for
  the `moneyRefinement` fix.

**Rate limiting**
- Per-user and per-IP counters independent (tested); the limiter sits **after**
  `requireAuth` (the production bug already found); health check exempt.

**Cron (`/internal/cron`) — zero tests today**
- Wrong secret, missing secret, correct secret.
- Each group (`daily`, `hourly`, `frequent`) enqueues its documented jobs.
- `inline: true` runs reconciliation and reports the invariant.
- Reconciliation detects a deliberately corrupted ledger.

**Realtime** — the WebSocket server attaches in `server.ts`, outside
`buildApp()`, so supertest cannot reach it. Either lift the attachment into a
testable seam or start a real server on an ephemeral port for this phase.
Decide, then test: upgrade rejected without a token, rejected for a non-member,
and a broadcast arriving only after commit.

**Exit:** idempotency and locking asserted on every route that declares them.

---

### Phase 8 — The nine critical journeys (PRD §15.2) ✅

**9 tests added** (`journeys.test.ts`). Suite: 526 → 535. **No new bugs — and
that is the result worth reporting.**

Eight of the nine passed on the first run. The ninth failed on my own wrong
guess at a query parameter (`?view=archived`; the contract says `archive`).
Nothing in the product broke.

That is meaningful rather than anticlimactic. These are the only tests that
cross module boundaries — every other test in the suite builds its world with
factories that write SQL directly and then exercises one module, which leaves
the *handoffs* as the least-tested code in the system. Seven earlier phases had
already fixed 23 bugs, several of them precisely at these seams (a block
deletion unlinking an expense, an invite acceptance minting a participant, a
claim moving a ledger identity). The journeys passing first time says those
fixes were the right ones.

Each journey is built end to end through the API, with SQL used only to plant an
invite token — which the API deliberately never exposes, since only its hash is
stored.

| # | Journey | Result |
|---|---|---|
| 1 | trip → 5 blocks over 2 days → invite → accept → both edit → export PDF | ✅ real `%PDF-` bytes |
| 2 | fork → modify → compare → promote → previous main intact | ✅ except compare |
| 3 | share link → fetched logged-out → guest comment → visible to the crew | ✅ |
| 4 | delete block, day and trip; restore each | ✅ full restoration |
| 5 | folder → archive → restore from archive | ✅ folder counts follow |
| 6 | date change with days present, all four strategies | ✅ |
| 7 | 6 expenses, 4 participants, 5 split methods, 2 currencies → settled | ✅ |
| 8 | planned cost → linked actual → delete block → expense survives | ✅ |
| 9 | claim a placeholder → full ledger history transfers | ✅ balances identical |

**Journey 2 is the one that cannot complete.** `FR-VAR-05` (compare variants)
has no route, so the journey asserts the compare endpoint returns 404 and
carries a message telling whoever builds it to come back and assert the diff.
The rest of the journey — fork, modify, promote, previous main intact — runs.

**Journey 7 is the one worth reading.** All five split methods against four
participants, plus a sixth expense in JPY with a frozen rate; every expense's
shares are asserted to sum exactly to its own total, `SUM(net) = 0` holds,
simplification stays within n−1 transfers, and then every proposed transfer is
actually recorded and confirmed until each participant's net is exactly `0` and
settle-up proposes nothing further. That is PRD §15.2 flow 7 end to end,
including the "trip reaches Settled" close.

---

### Phase 8 — original scope

Each is **one test**, building its world through the API rather than through
factories — because the handoffs between modules are the point. These are the
only tests in the suite that would catch a broken seam.

1. Sign up → create trip → 5 blocks across 2 days → invite → accept → both edit
   → export PDF.
2. Fork → modify → compare → promote → previous main intact. *(Compare has no
   route; the rest of the journey runs, with the gap recorded.)*
3. Share link → fetch logged-out → guest comment → owner is notified.
4. Delete block, day, and trip; restore each; confirm full restoration.
5. Move a trip to a folder → archive → restore from archive.
6. Change trip dates with days present → the `FR-TRIP-14` resolution prompt →
   each of the four strategies.
7. **The ledger journey**: 6 expenses, 4 participants (one a placeholder), all
   five split methods, two currencies → every share sums to its total → net
   balances sum to zero → simplify → settle → payee confirms → trip Settled.
8. Planned Cost on a block → linked actual expense → variance → **delete the
   block → expense survives, unlinks, balances unchanged.**
9. Claim a placeholder with a real account → full ledger history transfers with
   identical balances.

**Exit:** all nine run end to end, or their blocking gap is named.

---

## Working rules for the whole exercise

- **Fix before advancing.** A phase does not close with a known failure open. A
  missing *feature* is recorded and the phase closes; a *bug* is fixed.
- **Every fix gets the failing test first**, so the fix is proven rather than
  assumed.
- **Full suite green between phases** — not just the new file.
- **Bugs get written down.** `IMPLEMENTATION_STATUS.md` gains a row per real
  bug found, matching how the existing phases are documented. That record is
  the most valuable output of this exercise; the tests are the second.
- **No coverage theatre.** A route reached once is not a route tested. Phase
  exit criteria are behavioural, not numeric.
