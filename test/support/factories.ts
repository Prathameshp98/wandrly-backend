/**
 * Test data factories.
 *
 * Every factory generates a fresh UUIDv7, which matters for more than
 * uniqueness: `UserSyncService` keeps an in-process cache of recently-seen
 * users, so reusing a user id across tests would skip the row insert after the
 * table has been truncated, and every downstream FK would fail confusingly.
 */

import { eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';

import { db, withTransaction } from '../../src/platform/db/index';
import {
  folders,
  tripMembers,
  tripParticipants,
  trips,
  users,
  variants,
} from '../../src/platform/db/schema/index';
import { newId } from '../../src/platform/crypto/index';
import { env } from '../../src/platform/config/env';
import type { Role } from '../../src/platform/policy/index';

export interface TestUser {
  id: string;
  email: string;
  displayName: string;
  token: string;
}

/**
 * Mint a valid access token.
 *
 * This is what removes Supabase from the test loop entirely: we verify HS256
 * with a shared secret, so tests sign their own tokens with the same secret.
 */
export function tokenFor(userId: string, email = `${userId}@test.dev`): string {
  return jwt.sign(
    { sub: userId, aud: env.JWT_AUDIENCE, email, role: 'authenticated' },
    env.SUPABASE_JWT_SECRET!,
    { expiresIn: '1h' },
  );
}

export async function createUser(overrides: Partial<TestUser> = {}): Promise<TestUser> {
  const id = overrides.id ?? newId();
  const email = overrides.email ?? `${id}@test.dev`;
  const displayName = overrides.displayName ?? 'Test Traveller';

  await db
    .insert(users)
    .values({ id, email, displayName })
    .onConflictDoNothing();

  return { id, email, displayName, token: tokenFor(id, email) };
}

export async function createFolder(ownerId: string, name = 'Japan 2026') {
  const id = newId();
  const [row] = await db
    .insert(folders)
    .values({ id, ownerId, name, emoji: '🗾', tone: 'gold' })
    .returning();
  return row!;
}

export interface CreateTripOptions {
  ownerId: string;
  title?: string;
  destination?: string;
  baseCurrency?: string;
  folderId?: string;
  simplifyDebts?: boolean;
  isArchived?: boolean;
  tripMode?: 'FULL' | 'EXPENSES_ONLY';
  /** Create a ledger participant for the owner. Defaults to true. */
  withOwnerParticipant?: boolean;
}

export interface TestTrip {
  id: string;
  mainVariantId: string;
  ownerParticipantId: string | null;
  baseCurrency: string;
}

/**
 * A trip with its owner membership, main variant, and (by default) a ledger
 * participant for the owner — the minimum graph the API needs to be reachable.
 */
export async function createTrip(options: CreateTripOptions): Promise<TestTrip> {
  const tripId = newId();
  const variantId = newId();
  const baseCurrency = options.baseCurrency ?? 'INR';
  const ownerParticipantId: string | null =
    options.withOwnerParticipant === false ? null : newId();

  // One transaction, mirroring TripsService.create. Five separate autocommits
  // leave windows where the trip exists but its membership does not, and a
  // request landing in one of them sees a trip it has no access to.
  await withTransaction(async (tx) => {
  await tx.insert(trips).values({
    id: tripId,
    ownerId: options.ownerId,
    title: options.title ?? 'Kyoto in Spring',
    destination: options.destination ?? options.title ?? 'Kyoto, Japan',
    baseCurrency,
    folderId: options.folderId ?? null,
    simplifyDebts: options.simplifyDebts ?? true,
    isArchived: options.isArchived ?? false,
    tripMode: options.tripMode ?? 'FULL',
  });

  await tx.insert(variants).values({
    id: variantId,
    tripId,
    name: 'Main',
    isMain: true,
    createdBy: options.ownerId,
  });

  await tx.update(trips).set({ mainVariantId: variantId }).where(eq(trips.id, tripId));

  await tx.insert(tripMembers).values({
    tripId,
    userId: options.ownerId,
    role: 'OWNER',
  });

  if (options.withOwnerParticipant !== false) {
    await tx.insert(tripParticipants).values({
      id: ownerParticipantId!,
      tripId,
      userId: options.ownerId,
      displayName: 'Owner',
      createdBy: options.ownerId,
    });
  }
  });

  return { id: tripId, mainVariantId: variantId, ownerParticipantId, baseCurrency };
}

/** Add a member with a given role, plus their ledger identity. */
export async function addMember(
  tripId: string,
  role: Role,
  options: { withParticipant?: boolean; displayName?: string } = {},
): Promise<TestUser & { participantId: string | null }> {
  const user = await createUser({ displayName: options.displayName ?? role });
  const participantId: string | null =
    options.withParticipant === false ? null : newId();

  await withTransaction(async (tx) => {
    await tx.insert(tripMembers).values({ tripId, userId: user.id, role });

    if (participantId) {
      await tx.insert(tripParticipants).values({
        id: participantId,
        tripId,
        userId: user.id,
        displayName: options.displayName ?? role,
      });
    }
  });

  return { ...user, participantId };
}

/** A placeholder participant — no account, the FR-SPLIT-01 case. */
export async function addPlaceholder(
  tripId: string,
  displayName: string,
  createdBy?: string,
): Promise<string> {
  const id = newId();
  await db.insert(tripParticipants).values({
    id,
    tripId,
    userId: null,
    displayName,
    createdBy: createdBy ?? null,
  });
  return id;
}

/**
 * A trip with an owner and `count` additional participants, which is the shape
 * most ledger tests need.
 */
export async function createTripWithCrew(count = 2) {
  const owner = await createUser({ displayName: 'Arjun' });
  const trip = await createTrip({ ownerId: owner.id });

  const crew = [];
  for (let i = 0; i < count; i += 1) {
    crew.push(await addPlaceholder(trip.id, `Crew ${i + 1}`, owner.id));
  }

  return {
    owner,
    trip,
    participantIds: [trip.ownerParticipantId!, ...crew],
  };
}
