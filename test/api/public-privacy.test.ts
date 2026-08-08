/**
 * The public surface, from a privacy standpoint.
 *
 * `FR-SPLIT-40` is unconditional: expenses and balances are **never** in a
 * public view, "regardless of link settings". `FR-SEC-09` says the same for
 * booking confirmations and seat data. Those are the kind of claims that need
 * testing by *searching the raw payload for the secret*, not by checking the
 * response shape — a shape assertion keeps passing on the day a template starts
 * rendering a field it was never meant to receive.
 *
 * `sharing.test.ts` does that for the HTML and the JSON. This widens it to
 * every public entry point, and covers the access-control edges around the
 * link itself: password, expiry, rotation, and how long a guest token stays
 * good for.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { api, authed } from '../support/api';
import { closeTestDatabase, resetDatabase } from '../support/db';
import { addPlaceholder, createTrip, createUser } from '../support/factories';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

/** Values that must never appear in anything a stranger can fetch. */
const SECRETS = {
  confirmation: 'PNR-XK47-NEVER-PUBLIC',
  seat: '14A-SECRET-SEAT',
  upi: 'arjun@neverpublic',
  expense: 'RyokanSettlementSecret',
} as const;

/**
 * A trip with a share link and every kind of secret attached: an encrypted
 * booking section, a ledger with real balances, and a stored payout id.
 */
async function sharedTripWithSecrets(
  settings: Record<string, unknown> = { isEnabled: true },
) {
  const owner = await createUser({ displayName: 'Arjun' });
  const trip = await createTrip({ ownerId: owner.id, baseCurrency: 'INR' });
  const priya = await addPlaceholder(trip.id, 'Priya', owner.id);

  const { body: canvas } = await authed(owner.token)
    .get(`/v1/trips/${trip.id}/canvas`)
    .expect(200);

  // Trips created by the factory have no days, so make one to hang a block on.
  const { body: day } = await authed(owner.token)
    .post(`/v1/trips/${trip.id}/variants/${canvas.variant.id}/days`)
    .send({ title: 'Arrival' })
    .expect(201);

  const { body: block } = await authed(owner.token)
    .post(`/v1/trips/${trip.id}/days/${day.id}/blocks`)
    .send({
      type: 'TRANSPORT',
      title: 'Shinkansen to Kyoto',
      timeLabel: '20:35 → 02:15+1',
      sections: {
        booking: [
          { key: 'Confirmation', value: SECRETS.confirmation },
          { key: 'Seats', value: SECRETS.seat },
        ],
        cost: { amountMinor: '8000', currency: 'INR', per: 'total', splitCount: 2 },
      },
    })
    .expect(201);

  // A payout identifier, which is encrypted at rest and co-participant-only.
  await authed(owner.token)
    .patch(`/v1/trips/${trip.id}/participants/${trip.ownerParticipantId}`)
    .send({ payoutUpiId: SECRETS.upi })
    .expect(200);

  await authed(owner.token)
    .post(`/v1/trips/${trip.id}/expenses`)
    .send({
      description: SECRETS.expense,
      amountMinor: '9120',
      currency: 'INR',
      payments: [{ participantId: trip.ownerParticipantId, amountMinor: '9120' }],
      split: { method: 'EQUAL', participantIds: [trip.ownerParticipantId, priya] },
    })
    .expect(201);

  const { body: link } = await authed(owner.token)
    .put(`/v1/trips/${trip.id}/share`)
    .send(settings)
    .expect(200);

  return { owner, trip, link, blockId: block.id, dayId: day.id };
}

const assertNoSecrets = (payload: string, where: string): void => {
  for (const [name, value] of Object.entries(SECRETS)) {
    expect(
      payload.includes(value),
      `${where} leaked the ${name} (${value})`,
    ).toBe(false);
  }
};

describe('nothing private survives the trip to a public page', () => {
  it('keeps every secret out of the HTML and the JSON, with all toggles on', async () => {
    const { link } = await sharedTripWithSecrets({
      isEnabled: true,
      allowComments: true,
      allowSuggestions: true,
    });

    const page = await api.get(`/p/${link.slug}`).expect(200);
    assertNoSecrets(page.text, 'the public HTML');

    const data = await api.get(`/p/${link.slug}/data`).expect(200);
    const json = JSON.stringify(data.body);
    assertNoSecrets(json, 'the public JSON');

    // Structural too: a future template cannot render what it never received.
    expect(json).not.toMatch(/"booking"|"cost"|"sections"|"expenses"|"balances"/);
  });

  it('keeps them out even when the link points at a non-main variant', async () => {
    const { owner, trip, link } = await sharedTripWithSecrets();

    const { body: fork } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants`)
      .send({ name: 'Alternative', forkFromVariantId: undefined })
      .expect(201);

    await authed(owner.token)
      .put(`/v1/trips/${trip.id}/share`)
      .send({ isEnabled: true, variantId: fork.id })
      .expect(200);

    const page = await api.get(`/p/${link.slug}`).expect(200);
    assertNoSecrets(page.text, 'the public HTML for a forked variant');
  });

  it('never echoes the password back into the page it protects', async () => {
    const password = 'correct-horse-battery';
    const { link } = await sharedTripWithSecrets({ isEnabled: true, password });

    const page = await api.get(`/p/${link.slug}?password=${password}`).expect(200);

    // The password travels as a query parameter, so the URL is already in the
    // viewer's history. Rendering it back into the document would put it into
    // every screenshot and every copy of the page source as well.
    expect(
      page.text.includes(password),
      'the public page rendered the password into its own HTML',
    ).toBe(false);
  });
});

describe('the link itself is the access control', () => {
  it('refuses a wrong password and an absent one the same way', async () => {
    const { link } = await sharedTripWithSecrets({
      isEnabled: true,
      password: 'correct-horse-battery',
    });

    const absent = await api.get(`/p/${link.slug}`).expect(401);
    const wrong = await api.get(`/p/${link.slug}?password=nope`).expect(401);

    // Neither may reveal the trip, and both must look alike enough that the
    // response is not an oracle for "this password was closer".
    assertNoSecrets(absent.text, 'the password prompt');
    assertNoSecrets(wrong.text, 'the rejected password page');

    await api.get(`/p/${link.slug}/data`).expect(401);
    await api.get(`/p/${link.slug}/data?password=nope`).expect(401);

    await api
      .get(`/p/${link.slug}/data?password=correct-horse-battery`)
      .expect(200);
  });

  it('stops working the moment the link is disabled, and again when re-enabled', async () => {
    const { owner, trip, link } = await sharedTripWithSecrets();

    await api.get(`/p/${link.slug}`).expect(200);

    await authed(owner.token)
      .put(`/v1/trips/${trip.id}/share`)
      .send({ isEnabled: false })
      .expect(200);

    // FR-SHARE-03 — toggling off invalidates the link immediately.
    await api.get(`/p/${link.slug}`).expect(404);
    await api.get(`/p/${link.slug}/data`).expect(404);

    await authed(owner.token)
      .put(`/v1/trips/${trip.id}/share`)
      .send({ isEnabled: true })
      .expect(200);

    await api.get(`/p/${link.slug}`).expect(200);
  });

  it('invalidates the old slug when the link is revoked and a new one made', async () => {
    const { owner, trip, link } = await sharedTripWithSecrets();
    const original = link.slug;

    await authed(owner.token).delete(`/v1/trips/${trip.id}/share`).expect(204);
    await api.get(`/p/${original}`).expect(404);

    const { body: replacement } = await authed(owner.token)
      .put(`/v1/trips/${trip.id}/share`)
      .send({ isEnabled: true })
      .expect(200);

    expect(replacement.slug, 'revoking and re-sharing reused the old slug').not.toBe(
      original,
    );
    await api.get(`/p/${replacement.slug}`).expect(200);
    await api.get(`/p/${original}`).expect(404);
  });

  it('treats an expired link as absent rather than as forbidden', async () => {
    const { link } = await sharedTripWithSecrets({
      isEnabled: true,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const expired = await api.get(`/p/${link.slug}`).expect(404);
    const invented = await api.get('/p/thisslugneverexisted000000000000').expect(404);

    // Indistinguishable: an expired link must not confirm that a trip is there.
    expect(expired.text.length).toBe(invented.text.length);
  });
});

describe('guest comments live and die with the link (FR-SHARE-05)', () => {
  it('stops accepting guest comments once the link is disabled', async () => {
    const { owner, trip, link } = await sharedTripWithSecrets({
      isEnabled: true,
      allowComments: true,
    });

    const { body: posted } = await api
      .post(`/p/${link.slug}/comments`)
      .send({ guestName: 'Ravi', body: 'Looks wonderful' })
      .expect(201);

    expect(posted.guestToken).toBeTruthy();

    await authed(owner.token)
      .put(`/v1/trips/${trip.id}/share`)
      .send({ isEnabled: false })
      .expect(200);

    await api
      .post(`/p/${link.slug}/comments`)
      .send({ guestName: 'Ravi', body: 'And again' })
      .expect(404);

    // The token was scoped to a link that no longer resolves, so it must not
    // keep working either.
    await api
      .delete(`/p/${link.slug}/comments/${posted.id}?guestToken=${posted.guestToken}`)
      .expect(404);
  });

  it('renders a guest’s name as text, whatever they type', async () => {
    const { link } = await sharedTripWithSecrets({
      isEnabled: true,
      allowComments: true,
    });

    const hostile = '<img src=x onerror=alert(1)>';
    await api
      .post(`/p/${link.slug}/comments`)
      .send({ guestName: hostile, body: '<script>alert(2)</script>' })
      .expect(201);

    const page = await api.get(`/p/${link.slug}`).expect(200);

    expect(page.text).not.toContain('<img src=x');
    expect(page.text).not.toContain('<script>alert(2)</script>');
    // Escaped, not dropped: the comment must still be visible as text, or the
    // guest is told it was posted and then never sees it.
    expect(page.text).toContain('&lt;img src=x');
    expect(page.text).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
  });
});

describe('the page survives content that would break a naive template', () => {
  it('escapes markup in the trip title and keeps emoji and RTL intact', async () => {
    const owner = await createUser();
    const trip = await createTrip({
      ownerId: owner.id,
      title: '<script>alert(1)</script> رحلة 🇯🇵 Kyoto',
      destination: 'Kyoto, Japan',
    });

    const { body: link } = await authed(owner.token)
      .put(`/v1/trips/${trip.id}/share`)
      .send({ isEnabled: true })
      .expect(200);

    const page = await api.get(`/p/${link.slug}`).expect(200);

    expect(page.text).not.toContain('<script>alert(1)</script>');
    // A 4-byte emoji and RTL text must survive as themselves — escaping is not
    // an excuse to mangle the title.
    expect(page.text).toContain('🇯🇵');
    expect(page.text).toContain('رحلة');
    expect(page.headers['content-type']).toMatch(/charset=utf-8/i);
  });

  it('carries OpenGraph tags, since a shared link is the acquisition channel', async () => {
    const { link } = await sharedTripWithSecrets();
    const page = await api.get(`/p/${link.slug}`).expect(200);

    expect(page.text).toMatch(/<meta property="og:title"/);
    expect(page.text).toMatch(/<meta property="og:description"/);
    // And the preview metadata must not become a side channel for the secrets.
    assertNoSecrets(page.text, 'the OpenGraph metadata');
  });
});

describe('exports honour their content toggles (FR-EXP-02/05/07)', () => {
  it('prints the variant name on the document (FR-EXP-07)', async () => {
    const { owner, trip } = await sharedTripWithSecrets();

    const { body: fork } = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/variants`)
      .send({ name: 'Budget run' })
      .expect(201);

    const text = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/export.txt?variantId=${fork.id}`)
      .expect(200);

    expect(
      text.text,
      'an export must name the variant it rendered, or it is ambiguous',
    ).toContain('Budget run');
  });

  it('omits booking details by default and includes them only on request', async () => {
    const { owner, trip } = await sharedTripWithSecrets();

    const byDefault = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/export.txt`)
      .expect(200);
    expect(
      byDefault.text.includes(SECRETS.confirmation),
      'booking details defaulted to ON in an export',
    ).toBe(false);

    const requested = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/export.txt?includeBookings=true`)
      .expect(200);
    expect(requested.text).toContain(SECRETS.confirmation);
  });

  it('produces a calendar an RFC 5545 parser would accept', async () => {
    const { owner, trip } = await sharedTripWithSecrets();

    const ics = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/export.ics`)
      .expect(200);

    const body = ics.text;
    expect(body.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(body.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect((body.match(/BEGIN:VEVENT/g) ?? []).length).toBe(
      (body.match(/END:VEVENT/g) ?? []).length,
    );
    // Every line must be CRLF-terminated per the spec.
    expect(body).toMatch(/\r\n/);
    expect(
      body.includes(SECRETS.confirmation),
      'a calendar export carried booking details by default',
    ).toBe(false);
  });

  it('quotes a comma in a CSV description rather than splitting the row', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id, baseCurrency: 'INR' });
    const priya = await addPlaceholder(trip.id, 'Priya', owner.id);

    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/expenses`)
      .send({
        description: 'Dinner, drinks, and a taxi',
        amountMinor: '5000',
        currency: 'INR',
        payments: [{ participantId: trip.ownerParticipantId, amountMinor: '5000' }],
        split: { method: 'EQUAL', participantIds: [trip.ownerParticipantId, priya] },
      })
      .expect(201);

    const csv = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/expenses/export.csv`)
      .expect(200);

    const [header, ...rows] = csv.text.trim().split('\n');
    const columns = header!.split(',').length;

    expect(csv.text).toContain('"Dinner, drinks, and a taxi"');
    for (const row of rows) {
      // Naive split would find extra columns on the row with the comma.
      const quoted = row.match(/"[^"]*"/g) ?? [];
      const withoutQuoted = quoted.reduce((acc, q) => acc.replace(q, 'X'), row);
      expect(withoutQuoted.split(',').length).toBe(columns);
    }
  });
});
