/**
 * Sharing and exports.
 *
 * The privacy assertions matter most: FR-SPLIT-40 says group finances are never
 * in a public payload "without exception", and FR-SEC-09 says the same for
 * booking details. Those are tested by searching the raw response body for the
 * secret values, not by trusting the shape.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { api, authed } from '../support/api';
import { closeTestDatabase, resetDatabase } from '../support/db';
import { addMember, createUser } from '../support/factories';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  // Each file owns its pool under `isolate: true`, so each closes its own.
  await closeTestDatabase();
});

/** A trip with a booked block carrying booking + cost, and one expense. */
async function sharedTrip() {
  const owner = await createUser({ displayName: 'Arjun' });

  const { body: trip } = await authed(owner.token)
    .post('/v1/trips')
    .send({ destination: 'Kyoto, Japan', startDate: '2026-05-18', endDate: '2026-05-19' })
    .expect(201);

  const { body: canvas } = await authed(owner.token).get(`/v1/trips/${trip.id}/canvas`);

  await authed(owner.token)
    .post(`/v1/trips/${trip.id}/days/${canvas.days[0].id}/blocks`)
    .send({
      type: 'ACCOMMODATION',
      title: 'Yoshida-sanso Ryokan',
      timeLabel: 'Check-in 16:00',
      meta: '3 nights · Tatami Suite',
      isConfirmed: true,
      sections: {
        map: { lat: 35.0233, lng: 135.7847, name: 'Yoshida-sanso' },
        booking: [{ key: 'Confirmation', value: 'SECRET-PNR-M8X42L' }],
        cost: { amountMinor: '8640000', currency: 'INR', per: 'total', splitCount: 2 },
      },
    })
    .expect(201);

  await authed(owner.token)
    .post(`/v1/trips/${trip.id}/expenses`)
    .send({
      description: 'SECRET-EXPENSE-DESCRIPTION',
      amountMinor: '500000',
      currency: 'INR',
      payments: [{ participantId: trip.id && (await participantOf(owner.token, trip.id)), amountMinor: '500000' }],
      split: { method: 'EQUAL', participantIds: [await participantOf(owner.token, trip.id)] },
    })
    .expect(201);

  return { owner, trip, dayId: canvas.days[0].id };
}

async function participantOf(token: string, tripId: string): Promise<string> {
  const { body } = await authed(token).get(`/v1/trips/${tripId}/participants`);
  return body.items[0].id;
}

async function share(token: string, tripId: string, settings = {}) {
  const { body } = await authed(token)
    .put(`/v1/trips/${tripId}/share`)
    .send(settings)
    .expect(200);
  return body;
}

describe('share links', () => {
  it('creates a link with an unguessable slug', async () => {
    const { owner, trip } = await sharedTrip();
    const link = await share(owner.token, trip.id);

    expect(link.slug).toMatch(/^[\w-]{20,}$/);
    expect(link.url).toContain(`/p/${link.slug}`);
    expect(link.isEnabled).toBe(true);
    expect(link.allowComments).toBe(false);
    expect(link.hasPassword).toBe(false);
  });

  it('keeps one link per trip', async () => {
    const { owner, trip } = await sharedTrip();
    const first = await share(owner.token, trip.id);
    const second = await share(owner.token, trip.id, { allowComments: true });

    expect(second.id).toBe(first.id);
    expect(second.slug).toBe(first.slug);
    expect(second.allowComments).toBe(true);
  });

  it('forbids a CONTRIBUTOR from managing the link', async () => {
    const { trip } = await sharedTrip();
    const contributor = await addMember(trip.id, 'CONTRIBUTOR');

    await authed(contributor.token).put(`/v1/trips/${trip.id}/share`).send({}).expect(403);
  });
});

describe('public page', () => {
  it('renders without any authentication', async () => {
    const { owner, trip } = await sharedTrip();
    const link = await share(owner.token, trip.id);

    const res = await api.get(`/p/${link.slug}`).expect(200);

    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Kyoto, Japan');
    expect(res.text).toContain('Yoshida-sanso Ryokan');
    expect(res.text).toContain('DAY 01');
  });

  it('NEVER exposes the ledger or booking details (FR-SPLIT-40, FR-SEC-09)', async () => {
    const { owner, trip } = await sharedTrip();
    // Even with every sharing toggle turned on.
    const link = await share(owner.token, trip.id, {
      allowComments: true,
      allowSuggestions: true,
    });

    const html = (await api.get(`/p/${link.slug}`).expect(200)).text;
    const json = JSON.stringify((await api.get(`/p/${link.slug}/data`).expect(200)).body);

    // No secret VALUE appears in either representation.
    for (const payload of [html, json]) {
      expect(payload).not.toContain('SECRET-PNR-M8X42L');
      expect(payload).not.toContain('SECRET-EXPENSE-DESCRIPTION');
      expect(payload).not.toContain('8640000'); // the cost, in minor units
      expect(payload).not.toContain('500000'); // the expense, in minor units
    }

    // And structurally: the JSON carries no booking or cost keys at all, so a
    // future template cannot accidentally render what it was never given.
    // (The HTML footer legitimately uses the word "bookings" in copy, which is
    // why this is a key check rather than a substring search.)
    const data = (await api.get(`/p/${link.slug}/data`)).body as {
      days: { blocks: Record<string, unknown>[] }[];
    };
    for (const day of data.days) {
      for (const block of day.blocks) {
        expect(block).not.toHaveProperty('booking');
        expect(block).not.toHaveProperty('cost');
        expect(block).not.toHaveProperty('sections');
      }
    }
  });

  it('carries OpenGraph tags — link previews are the acquisition channel', async () => {
    const { owner, trip } = await sharedTrip();
    const link = await share(owner.token, trip.id);
    const html = (await api.get(`/p/${link.slug}`)).text;

    expect(html).toMatch(/<meta property="og:title" content="[^"]+"/);
    expect(html).toMatch(/<meta property="og:description"/);
    expect(html).toMatch(/<meta property="og:url"/);
    expect(html).toMatch(/<meta name="twitter:card"/);
    expect(html).toMatch(/rel="canonical"/);
  });

  it('escapes user content rather than injecting it', async () => {
    const owner = await createUser();
    const { body: trip } = await authed(owner.token)
      .post('/v1/trips')
      .send({ destination: 'Nowhere', title: '<script>alert(1)</script>' })
      .expect(201);

    const link = await share(owner.token, trip.id);
    const html = (await api.get(`/p/${link.slug}`)).text;

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('404s once disabled, revoked, or expired — indistinguishably', async () => {
    const { owner, trip } = await sharedTrip();
    const link = await share(owner.token, trip.id);

    await api.get(`/p/${link.slug}`).expect(200);

    await share(owner.token, trip.id, { isEnabled: false });
    await api.get(`/p/${link.slug}`).expect(404);

    await share(owner.token, trip.id, { isEnabled: true });
    await api.get(`/p/${link.slug}`).expect(200);

    await authed(owner.token).delete(`/v1/trips/${trip.id}/share`).expect(204);
    await api.get(`/p/${link.slug}`).expect(404);
  });

  it('404s for a made-up slug', async () => {
    await api.get('/p/definitely-not-a-real-slug-here').expect(404);
  });

  it('prompts for a password when protected (FR-SHARE-08)', async () => {
    const { owner, trip } = await sharedTrip();
    const link = await share(owner.token, trip.id, { password: 'kyoto2026' });

    const locked = await api.get(`/p/${link.slug}`).expect(401);
    expect(locked.text).toContain('password protected');
    expect(locked.text).not.toContain('Yoshida-sanso');

    const opened = await api.get(`/p/${link.slug}?password=kyoto2026`).expect(200);
    expect(opened.text).toContain('Yoshida-sanso');

    await api.get(`/p/${link.slug}?password=wrong`).expect(401);
  });

  it('respects an expiry date', async () => {
    const { owner, trip } = await sharedTrip();
    const link = await share(owner.token, trip.id, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await api.get(`/p/${link.slug}`).expect(404);
  });
});

describe('guest comments (FR-SHARE-05)', () => {
  it('are refused unless the toggle is on', async () => {
    const { owner, trip } = await sharedTrip();
    const link = await share(owner.token, trip.id);

    await api
      .post(`/p/${link.slug}/comments`)
      .send({ guestName: 'Mum', body: 'Looks lovely' })
      .expect(403);
  });

  it('are accepted when enabled, and appear on the page', async () => {
    const { owner, trip } = await sharedTrip();
    const link = await share(owner.token, trip.id, { allowComments: true });

    const { body: canvas } = await authed(owner.token).get(`/v1/trips/${trip.id}/canvas`);
    const blockId = canvas.days[0].blocks[0].id;

    const { body: created } = await api
      .post(`/p/${link.slug}/comments`)
      .send({ guestName: 'Mum', body: 'Have a wonderful time', blockId })
      .expect(201);

    // The guest gets a token so they can remove their own comment later.
    expect(created.guestToken).toBeTruthy();

    const html = (await api.get(`/p/${link.slug}`)).text;
    expect(html).toContain('Have a wonderful time');
    expect(html).toContain('Mum');

    // The crew sees it too.
    const { body: comments } = await authed(owner.token).get(`/v1/trips/${trip.id}/comments`);
    expect(comments.items).toHaveLength(1);
    expect(comments.items[0].guestName).toBe('Mum');
  });

  it('lets a guest delete their own comment, but not someone else’s', async () => {
    const { owner, trip } = await sharedTrip();
    const link = await share(owner.token, trip.id, { allowComments: true });

    const { body: created } = await api
      .post(`/p/${link.slug}/comments`)
      .send({ guestName: 'Mum', body: 'Oops' })
      .expect(201);

    await api
      .delete(`/p/${link.slug}/comments/${created.id}?guestToken=wrong-token-entirely`)
      .expect(403);

    await api
      .delete(`/p/${link.slug}/comments/${created.id}?guestToken=${created.guestToken}`)
      .expect(204);
  });
});

describe('exports', () => {
  it('produces a readable plain-text itinerary', async () => {
    const { owner, trip } = await sharedTrip();
    const res = await authed(owner.token).get(`/v1/trips/${trip.id}/export.txt`).expect(200);

    expect(res.text).toContain('DAY 01');
    expect(res.text).toContain('Yoshida-sanso Ryokan');
    expect(res.text).toContain('Planned with Wandrly');
  });

  it('excludes booking details by default and includes them on request (FR-EXP-02)', async () => {
    const { owner, trip } = await sharedTrip();

    const off = await authed(owner.token).get(`/v1/trips/${trip.id}/export.txt`).expect(200);
    expect(off.text).not.toContain('SECRET-PNR-M8X42L');

    const on = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/export.txt?includeBookings=true`)
      .expect(200);
    expect(on.text).toContain('SECRET-PNR-M8X42L');
  });

  it('produces a valid RFC 5545 calendar', async () => {
    const { owner, trip } = await sharedTrip();
    const res = await authed(owner.token).get(`/v1/trips/${trip.id}/export.ics`).expect(200);

    expect(res.headers['content-type']).toMatch(/text\/calendar/);
    expect(res.text.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(res.text.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(res.text).toContain('VERSION:2.0');
    expect(res.text).toContain('BEGIN:VEVENT');
    expect(res.text).toContain('UID:');
    expect(res.text).toContain('DTSTAMP:');
    // Untimed block on a dated day becomes an all-day event.
    expect(res.text).toMatch(/DTSTART;VALUE=DATE:\d{8}/);
    // CRLF line endings are required by the spec.
    expect(res.text).toContain('\r\n');
    // Every BEGIN has an END.
    const begins = (res.text.match(/BEGIN:VEVENT/g) ?? []).length;
    const ends = (res.text.match(/END:VEVENT/g) ?? []).length;
    expect(begins).toBe(ends);
    expect(begins).toBeGreaterThan(0);
  });

  it('produces a real PDF', async () => {
    const { owner, trip } = await sharedTrip();
    const res = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/export.pdf`)
      .buffer()
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);

    const pdf = res.body as Buffer;
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    // %PDF- magic bytes, and a plausible size.
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(800);
  });

  it('exports the expense ledger as CSV, one row per share', async () => {
    const { owner, trip } = await sharedTrip();
    const res = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/expenses/export.csv`)
      .expect(200);

    const lines = res.text.trim().split('\n');
    expect(lines[0]).toContain('date,description,category');
    expect(lines[0]).toContain('share_in_inr');
    expect(lines).toHaveLength(2); // header + one share
    expect(lines[1]).toContain('SECRET-EXPENSE-DESCRIPTION');
  });

  it('requires trip access', async () => {
    const { trip } = await sharedTrip();
    const stranger = await createUser();
    await authed(stranger.token).get(`/v1/trips/${trip.id}/export.txt`).expect(404);
  });
});
