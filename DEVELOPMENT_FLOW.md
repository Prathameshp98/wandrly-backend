# Development & testing flow

How the Wandrly backend gets built and verified, from here to production.

**Context:** solo developer · frontend not started · ≤30 users · Koyeb + Supabase free tier.
Companion to `PRD.md`, `TECHNICAL_DESIGN.md`, and `IMPLEMENTATION_STATUS.md`.

---

## 1. The five test layers, and when each applies

The word "integration" means two different things, and conflating them is why this
section exists.

| # | Layer | Tests | Needs frontend? | Speed | Status |
|---|---|---|---|---|---|
| 1 | **Unit** | Pure functions — money, policy, split resolution | No | ~400ms | ✅ 199 passing |
| 2 | **API** | HTTP → Express → real Postgres → response | **No** | ~5–15s | ❌ none yet |
| 3 | **Contract** | `openapi.json` matches the code | No | instant | ✅ in CI |
| 4 | **Manual smoke** | Clicking endpoints yourself | No | — | ✅ `/docs` |
| 5 | **System / E2E** | Browser → frontend → API → DB | **Yes** | minutes | ⏸ after frontend |

**Layers 1–4 are the backend's own verification and run today.** Layer 5 is deferred
until the frontend exists — that is the one being postponed.

### Why layer 2 cannot wait for the frontend

- A failure in a browser test is ambiguous: frontend bug, backend bug, or contract
  mismatch? An API test failure has exactly one possible source.
- Eight modules written with zero verification means the first real run debugs eight
  interacting unknowns at once.
- The ledger is *already written and shipped* with no API-level coverage. That is a
  gap today, not a future one.
- Financial correctness in particular: the deferred DB triggers were verified by hand
  once. Nothing currently re-verifies them on every change.

---

## 2. The per-module development loop

Every remaining module follows the same nine steps. This ordering is deliberate:
contracts first means the API shape is settled before any logic is written, and tests
before the OpenAPI entry means the endpoint is proven before it is published.

```
1. Contract        src/contracts/<module>.ts        Zod schemas: request + response
2. Migration       npm run db:generate              only if schema changes
3. Repository      <module>.repository.ts           SQL only. Takes an Executor.
4. Service         <module>.service.ts              business rules. Injected deps.
5. Routes          <module>.routes.ts               3 lines each: delegate, serialise, respond
6. Presenter       <module>.presenter.ts            row → DTO. The only place data leaves.
7. API tests       test/api/<module>.test.ts        happy path + authz + edge cases
8. OpenAPI         register paths in generate-openapi.ts
9. Verify          npm run typecheck && lint && test && openapi
```

### Definition of done for a module

- [ ] Every endpoint validates params/query/body with Zod
- [ ] Every trip-scoped endpoint goes through `withTripAccess`
- [ ] **Authorization tested for all four roles** — not just the happy path
- [ ] Optimistic locking on anything concurrently editable
- [ ] Soft delete + restore where the PRD promises undo
- [ ] Activity event written inside the same transaction as the mutation
- [ ] Realtime broadcast queued via `DeferredBroadcast`, flushed after commit
- [ ] Registered in `openapi.json` (CI fails if stale)
- [ ] `npm run typecheck && npm run lint && npm test` green

---

## 3. Test harness (build once, before the next module)

Four small files unlock everything after them.

### `test/support/db.ts`
Each test runs inside a transaction that rolls back, so tests never leak into each
other and the suite stays fast without truncating tables.

```ts
export async function withRollback(fn: (tx: Tx) => Promise<void>) { /* … */ }
export async function resetDatabase() { /* truncate all, for suite setup */ }
```

### `test/support/auth.ts`
**This is what removes the Supabase dependency from testing.** We verify HS256 with a
shared secret, so tests mint their own valid tokens with that same secret.

```ts
export function tokenFor(userId: string): string {
  return jwt.sign({ sub: userId, aud: 'authenticated', email: `${userId}@test.dev` },
                  env.SUPABASE_JWT_SECRET, { expiresIn: '1h' });
}
```

No Supabase project, no network, no credentials.

### `test/support/factories.ts`
```ts
factories.user()            // → { id, token }
factories.trip({ ownerId, role })
factories.participant({ tripId, displayName })
factories.expense({ tripId, amountMinor, currency, split })
```

### `test/support/app.ts`
One built Express instance shared across the suite, wrapped in `supertest`.

### What a test then looks like

```ts
it('keeps the ledger balanced across a full settle-up cycle', async () => {
  const { userId, token } = await factories.user();
  const trip = await factories.trip({ ownerId: userId, baseCurrency: 'INR' });
  const [arjun, priya, sana] = await factories.participants(trip.id, 3);

  await api.post(`/v1/trips/${trip.id}/expenses`).auth(token)
    .send({ description: 'Ryokan', amountMinor: '10000', currency: 'JPY',
            payments: [{ participantId: arjun.id, amountMinor: '10000' }],
            split: { method: 'EQUAL', participantIds: [arjun.id, priya.id, sana.id] } })
    .expect(201);

  const { body } = await api.get(`/v1/trips/${trip.id}/balances`).auth(token).expect(200);
  expect(sumNet(body.balances)).toBe('0');           // the invariant, over HTTP

  const { body: settle } = await api.get(`/v1/trips/${trip.id}/settle-up`).auth(token);
  expect(settle.transfers).toHaveLength(2);          // ≤ n−1
});
```

---

## 4. What to test per module

Not exhaustive — the shape of coverage that makes a module trustworthy.

| Module | Must cover |
|---|---|
| **ledger** (retrofit) | Balance invariant over HTTP · all 5 split methods · Viewer sees only own shares · settle-up clears · participant removal blocked with history · refunds |
| **trips** | CRUD · per-user pinning (two users, independent) · archive/restore · duplicate deep-copies · **date-change strategy prompt** (`FR-TRIP-14`) · readiness computation · soft delete + restore |
| **folders** | CRUD · folder delete leaves trips unfiled, not deleted · counts exclude archived |
| **canvas** | **Variant fork deep-copies days+blocks and they diverge** · day renumbering after delete · block reorder within day · cross-day move · all 6 section types · block-level optimistic locking |
| **collab** | Invite lifecycle incl. expiry · role changes · Contributor can edit own block but not another's · comment threading · suggestion accept creates a block |
| **sharing** | Public page needs no auth · **ledger absent from public payload regardless of settings** · disabled link 404s · OG tags present |
| **exports** | ICS parses and has correct timezones · PDF generates · booking details excluded unless opted in |
| **search** | Only returns trips you're a member of · block hits deep-link correctly |

**The authorization matrix deserves a dedicated pass**: for each endpoint, assert all
four roles get the expected 200/403. That is mechanical and catches the bug class that
matters most.

---

## 5. Phase plan

Each phase ends with a verifiable checkpoint you can see yourself.

| Phase | Work | Checkpoint |
|---|---|---|
| **A** | Test harness + API tests for the existing ledger + `db:seed` (Kyoto data) | `npm test` covers the ledger end-to-end |
| **B** | Idempotency middleware | Duplicate `POST /expenses` returns the first response, not a second expense |
| **C** | **trips + folders** | **API usable end-to-end for the first time** — create a trip via HTTP, then a ledger on it |
| **D** | canvas (variants, days, blocks, sections) | Fork a variant, edit it, confirm the original is untouched |
| **E** | collab (invites, members, comments, suggestions) | Two users edit one trip; realtime events fire |
| **F** | sharing + exports | Open a public link logged-out; download a PDF |
| **G** | search, media, notifications API, packing, notes | Feature-complete backend |
| **H** | Deploy to Koyeb | `/health` green in production, cron ticking |
| — | *frontend begins* | consumes `openapi.json` |
| **I** | **System / E2E tests** | The 9 PRD §15.2 flows through the real UI |
| **J** | UAT with real users | |

Phase C is the one that changes how this feels — before it, the API can only be
exercised with SQL-seeded data.

---

## 6. Verifying progress without a frontend

Four ways, in increasing convenience:

1. **`npm test`** — the real signal. Fast, repeatable, runs in CI.
2. **Swagger UI at `/docs`** — click through any endpoint. Paste a token from
   `npm run token:dev` into the Authorize box.
3. **Seeded data** — `npm run db:seed` loads the prototype's Kyoto dataset: 9 trips,
   41 blocks, all 11 block types, 3 variants, 6 collaborators, and **all JPY**, so
   zero-decimal rounding is exercised from day one.
4. **A `.http` / Bruno collection** generated from `openapi.json` — a clickable request
   library for manual exploration.

---

## 7. CI gates

`.github/workflows/ci.yml` already runs on every push, with a Postgres service
container. Current gates:

```
typecheck → lint → unit tests → migrations apply → openapi not stale → build
```

To add in Phase A:

```
… → API tests (against the CI Postgres) → coverage thresholds
```

The `openapi.json` drift check matters more than usual here: with the frontend
undecided, that file is the contract, and a silent change to it is a silent breaking
change for a client that doesn't exist yet.

---

## 8. Environments

| | Database | Auth | Purpose |
|---|---|---|---|
| **Local** | Homebrew Postgres `wandrly_dev` | Self-minted HS256 tokens | Development |
| **CI** | Ephemeral Postgres service container | Self-minted | Every push |
| **Production** | Supabase (Singapore) | Real Supabase Auth | Koyeb |

**No staging environment** — deliberate (`TECHNICAL_DESIGN` §15.1). A good local setup
plus fast rollback covers it for one developer, and a third environment is a third
thing to keep in sync.

**You do not need to give me any credentials to develop or test.** Supabase is required
only at Phase H, to deploy.

---

## 9. When the frontend arrives

The handoff is one file.

1. Frontend generates a typed client from `openapi.json`
   (`openapi-typescript`, `orval`, or the equivalent in whatever language it lands in).
2. Point it at the local API via `CORS_ORIGINS` — configuration, not a code change.
3. **Then** Phase I: system tests through the browser, covering the 9 flows in PRD §15.2.
4. Those become the regression suite that protects both sides.

Because the backend already has API tests by then, a system-test failure means either a
frontend bug or a contract misunderstanding — never an unverified backend. That is the
entire reason for not deferring layer 2.

---

## 10. Recommendation

**Build the harness now (Phase A), then every module ships tested.**

The cost is roughly half a session. The alternative — eight modules written blind, then
verified through a UI that doesn't exist yet — front-loads no work and back-loads all
the risk, in a system whose core feature is other people's money.
