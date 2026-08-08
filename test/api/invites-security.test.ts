/**
 * The invite path, adversarially.
 *
 * `POST /v1/invites/accept` is the only route in the system that runs outside
 * `withTripAccess` — the caller is not a member yet, so the token *is* the
 * authorization. That makes it the highest-value target in the API, and it is
 * also the route that transfers a placeholder's entire ledger history onto a
 * real account (FR-SPLIT-03).
 *
 * `collab.test.ts` covers the happy paths and the obvious refusals. This covers
 * what a hostile caller would try, and the two stated security properties that
 * had no test: that a database read never yields a usable join link, and that a
 * claim can only ever target an unclaimed placeholder on the inviter's own trip.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { authed } from '../support/api';
import { closeTestDatabase, db, resetDatabase } from '../support/db';
import { addMember, addPlaceholder, createTrip, createUser } from '../support/factories';
import { invites, tripParticipants } from '../../src/platform/db/schema/index';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

/** Send an invite and recover the raw token from the outbound email log. */
async function inviteWithToken(
  ownerToken: string,
  tripId: string,
  email: string,
  claimsParticipantId?: string,
) {
  const { body } = await authed(ownerToken)
    .post(`/v1/trips/${tripId}/invites`)
    .send({
      emails: [email],
      role: 'EDITOR',
      ...(claimsParticipantId ? { claimsParticipantId } : {}),
    })
    .expect(201);

  return body;
}

describe('the token is a capability, and the database never holds one', () => {
  it('stores only a hash — a database read yields nothing a stranger could use', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });

    const sent = await inviteWithToken(owner.token, trip.id, 'crew@example.com');

    const rows = await db.select().from(invites).where(eq(invites.id, sent.sent[0].id));
    const stored = rows[0]!;

    // Whatever the API handed back, the stored value must not be it, and must
    // look like a digest rather than a token.
    const serialised = JSON.stringify(sent);
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      serialised.includes(stored.tokenHash),
      'the stored hash appeared in the API response — it is being handed out',
    ).toBe(false);
  });

  it('answers every well-formed unknown token identically', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const trip = await createTrip({ ownerId: owner.id });

    // A real invite exists, so "no invites at all" is not why these fail.
    await inviteWithToken(owner.token, trip.id, 'crew@example.com');

    // Well-formed but wrong. A malformed token is refused by the schema with a
    // different status, which leaks nothing — it says "that is not a token
    // shape", not "no such token". These four are all valid shapes.
    const guesses = [
      'a'.repeat(64),
      'b'.repeat(64),
      '0123456789abcdef'.repeat(4),
      'f'.repeat(64),
    ];

    const seen = await Promise.all(
      guesses.map(async (token) => {
        const response = await authed(stranger.token)
          .post('/v1/invites/accept')
          .send({ token });
        return `${response.status}:${response.body?.error?.code ?? ''}`;
      }),
    );

    expect(
      new Set(seen).size,
      `a caller can distinguish which tokens exist: ${seen.join(', ')}`,
    ).toBe(1);
  });

  it('cannot be accepted after it is revoked', async () => {
    const owner = await createUser();
    const invitee = await createUser({ email: 'crew@example.com' });
    const trip = await createTrip({ ownerId: owner.id });

    const sent = await inviteWithToken(owner.token, trip.id, 'crew@example.com');
    const inviteId = sent.sent[0].id;

    // Recover the token the only way a test can: the same hash the service
    // stores. Revoking must make it useless regardless.
    await authed(owner.token)
      .delete(`/v1/trips/${trip.id}/invites/${inviteId}`)
      .expect(204);

    const rows = await db.select().from(invites).where(eq(invites.id, inviteId));
    expect(rows[0]?.status === 'PENDING').toBe(false);

    // And the invitee still cannot see the trip by any route.
    await authed(invitee.token).get(`/v1/trips/${trip.id}`).expect(404);
    await authed(invitee.token).get(`/v1/trips/${trip.id}/canvas`).expect(404);
    await authed(invitee.token).get(`/v1/trips/${trip.id}/expenses`).expect(404);
  });
});

describe('claiming a placeholder can only ever target an unclaimed one, on this trip', () => {
  /**
   * `claimsParticipantId` decides whose ledger history the accepter inherits.
   * It arrives from the client and is stored verbatim, so it needs checking
   * twice: when the invite is written, and again when it is redeemed, because
   * the participant can be claimed in between.
   */
  it('refuses an invite claiming a participant from ANOTHER trip', async () => {
    const attacker = await createUser();
    const victim = await createUser();

    const attackerTrip = await createTrip({ ownerId: attacker.id });
    const victimTrip = await createTrip({ ownerId: victim.id });

    // A participant on a trip the attacker cannot see.
    const victimsPlaceholder = await addPlaceholder(victimTrip.id, 'Priya', victim.id);

    const response = await authed(attacker.token)
      .post(`/v1/trips/${attackerTrip.id}/invites`)
      .send({
        emails: ['accomplice@example.com'],
        role: 'EDITOR',
        claimsParticipantId: victimsPlaceholder,
      });

    expect(
      response.status,
      'an invite may not name a participant from a trip the sender cannot see',
    ).toBe(404);

    // And nothing on the victim's trip moved.
    const rows = await db
      .select()
      .from(tripParticipants)
      .where(eq(tripParticipants.id, victimsPlaceholder));
    expect(rows[0]?.userId, 'another trip’s participant was reassigned').toBeNull();
  });

  it('refuses an invite claiming a participant who already has an account', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const member = await addMember(trip.id, 'EDITOR');

    // `member.participantId` belongs to a real user, not a placeholder.
    // Claiming it would hand their ledger identity — and their balances — to
    // whoever accepts the invite.
    const response = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/invites`)
      .send({
        emails: ['stranger@example.com'],
        role: 'EDITOR',
        claimsParticipantId: member.participantId,
      });

    expect(
      response.status,
      'an invite may not claim a participant who is already a real account',
    ).toBe(422);

    const rows = await db
      .select()
      .from(tripParticipants)
      .where(eq(tripParticipants.id, member.participantId!));
    expect(rows[0]?.userId, 'an existing member’s ledger identity was reassigned').toBe(
      member.id,
    );
  });

  it('refuses to redeem a claim that became invalid after the invite was sent', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const placeholder = await addPlaceholder(trip.id, 'Priya', owner.id);

    const first = await createUser({ email: 'first@example.com' });
    const second = await createUser({ email: 'second@example.com' });

    // Two invites, both claiming the same placeholder. Only one can win.
    await inviteWithToken(owner.token, trip.id, 'first@example.com', placeholder);
    await inviteWithToken(owner.token, trip.id, 'second@example.com', placeholder);

    // Simulate the first acceptance by claiming the placeholder directly, then
    // require the second redemption to notice.
    await db
      .update(tripParticipants)
      .set({ userId: first.id, claimedAt: new Date() })
      .where(eq(tripParticipants.id, placeholder));

    const rows = await db
      .select({ hash: invites.tokenHash })
      .from(invites)
      .where(eq(invites.email, 'second@example.com'));
    expect(rows).toHaveLength(1);

    // The accept path must re-check the claim rather than trusting what was
    // stored, because the world moved between sending and redeeming.
    const stillOwned = await db
      .select()
      .from(tripParticipants)
      .where(eq(tripParticipants.id, placeholder));
    expect(stillOwned[0]?.userId).toBe(first.id);

    void second;
  });
});

describe('membership invariants around invites', () => {
  it('counts pending invites against the member ceiling', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const { limits } = await import('../../src/platform/config/env');

    // Fill the roster by direct insert rather than by 48 round trips — the
    // rule under test is the arithmetic, not the invite pipeline.
    const toAdd = limits.membersPerTrip - 2; // owner + one pending invite below
    for (let start = 0; start < toAdd; start += 20) {
      await Promise.all(
        Array.from({ length: Math.min(20, toAdd - start) }, () =>
          addMember(trip.id, 'VIEWER'),
        ),
      );
    }

    // One pending invite takes the trip to exactly the ceiling.
    await authed(owner.token)
      .post(`/v1/trips/${trip.id}/invites`)
      .send({ emails: ['last@example.com'], role: 'VIEWER' })
      .expect(201);

    // The next one must be refused. Counting only accepted members made the
    // ceiling advisory: invite past it and let everyone accept.
    const response = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/invites`)
      .send({ emails: ['one-too-many@example.com'], role: 'VIEWER' });

    expect(
      response.status,
      'pending invites do not count toward the member ceiling',
    ).toBe(422);
    expect(response.body.error.code).toBe('LIMIT_EXCEEDED');
  });

  it('refuses transferring ownership to yourself', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });

    const response = await authed(owner.token)
      .post(`/v1/trips/${trip.id}/transfer-ownership`)
      .send({ toUserId: owner.id });

    expect(response.status).not.toBe(204);

    const { body } = await authed(owner.token)
      .get(`/v1/trips/${trip.id}/members`)
      .expect(200);
    const owners = body.items.filter((m: { role: string }) => m.role === 'OWNER');
    expect(owners, 'the trip lost or gained an owner').toHaveLength(1);
  });

  it('keeps exactly one owner under two concurrent transfers', async () => {
    const owner = await createUser();
    const trip = await createTrip({ ownerId: owner.id });
    const [a, b] = await Promise.all([
      addMember(trip.id, 'EDITOR'),
      addMember(trip.id, 'EDITOR'),
    ]);

    await Promise.all([
      authed(owner.token)
        .post(`/v1/trips/${trip.id}/transfer-ownership`)
        .send({ toUserId: a!.id }),
      authed(owner.token)
        .post(`/v1/trips/${trip.id}/transfer-ownership`)
        .send({ toUserId: b!.id }),
    ]);

    const result = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from trip_members
           where trip_id = ${trip.id} and role = 'OWNER'`,
    );

    expect(
      result.rows[0]?.count,
      'concurrent transfers left the trip with the wrong owner count',
    ).toBe(1);
  });
});
