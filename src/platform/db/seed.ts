/**
 * Development seed — the prototype's dataset, per PRD §15.3.
 *
 * TECHNICAL_DESIGN §13.2: "The seed script must load the prototype's actual
 * dataset. It is unusually good test data."
 *
 * The fixture itself lives in `seed.data.ts`; this file is the insert logic.
 *
 * Notably the ledger is **entirely JPY**, a zero-decimal currency, so the
 * rounding edge cases that break naive money code are exercised from the first
 * day of development rather than discovered in production.
 *
 * Idempotent: truncates and reseeds.
 */

import { sql } from 'drizzle-orm';

import { closeDatabase, db, withTransaction } from './index';
import {
  blocks,
  days,
  expensePayments,
  expenseShares,
  expenses,
  folders,
  tripMembers,
  tripParticipants,
  trips,
  users,
  variants,
} from './schema/index';
import { newId } from '../crypto/index';
import { allocateBoth, convertMinor, parseRate } from '../../money/index';
import { logger } from '../logging/logger';
import { env, isProduction } from '../config/env';
import {
  FOLDERS,
  ID,
  KYOTO_DAYS,
  KYOTO_EXPENSES,
  KYOTO_VARIANTS,
  TOKYO_DAYS,
  TRIPS,
  USERS,
} from './seed.data';

const JPY_TO_INR = '0.58000000';

/**
 * Hosts this script is willing to truncate.
 *
 * `postgres` is the service name in docker-compose; `host.docker.internal`
 * reaches the host from inside a container.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal', 'postgres']);

/**
 * Refuse to run anywhere but a local database.
 *
 * `NODE_ENV` is a claim about intent; `DATABASE_URL` is the fact about where
 * the writes land. Guarding on the claim alone leaves a real hole: a local
 * `.env` saying `NODE_ENV=development` while `DATABASE_URL` points at the
 * production pooler passes the check and then truncates eighteen tables in
 * production. That exact configuration existed in this repo.
 *
 * So the target is verified as well as the label. Deliberate work against a
 * remote database goes through `db:migrate` with an explicit
 * `DATABASE_URL="$PROD_DATABASE_URL"`, which is a different command that does
 * not destroy anything.
 */
function assertLocalDatabase(): void {
  if (isProduction) {
    throw new Error('Refusing to seed a production database');
  }

  let hostname: string;
  try {
    ({ hostname } = new URL(env.DATABASE_URL));
  } catch {
    throw new Error('Refusing to seed: DATABASE_URL is not a parseable URL');
  }

  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error(
      `Refusing to seed a non-local database (host: ${hostname}).\n` +
        'Seeding truncates every table. Point DATABASE_URL at a local database — ' +
        'see .env.example — and keep the production URL in PROD_DATABASE_URL.',
    );
  }
}

/**
 * Optionally hand the whole fixture to a real Supabase account.
 *
 * The backend mirrors each Supabase user into its own `users` table on first
 * sight, so signing in for real otherwise lands on an empty dashboard — the
 * fixture belongs to the seeded Arjun, not to you. Set `SEED_OWNER_ID` to your
 * Supabase user id (Dashboard → Authentication → Users) and Arjun's row takes
 * that id instead, so every trip, membership and expense follows.
 */
function resolveOwnerId(): { ownerId: string; claimed: boolean } {
  const override = process.env.SEED_OWNER_ID?.trim();
  if (!override) return { ownerId: ID.arjun, claimed: false };

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(override)) {
    throw new Error(`SEED_OWNER_ID is not a UUID: ${override}`);
  }
  return { ownerId: override, claimed: true };
}

/**
 * Every date from `startDate` to `endDate`, inclusive.
 *
 * Walks the calendar rather than dividing a millisecond span: `setUTCDate`
 * handles month and year ends itself, and there is no rounding to get wrong.
 * The repo also bans `Math.round` outright — it is a blunt guard against
 * floating-point money, and worth not chipping away at for a date helper.
 */
function datesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const last = new Date(`${endDate}T00:00:00Z`);

  // A single day when the range is inverted or malformed, so a bad fixture
  // yields one empty day rather than an unbounded loop.
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(last.getTime()) || last < cursor) {
    return [startDate];
  }

  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

type SeedDay = (typeof KYOTO_DAYS)[number];

async function seed(): Promise<void> {
  assertLocalDatabase();

  const { ownerId, claimed } = resolveOwnerId();
  logger.info({ ownerId, claimed }, 'seeding development data');

  await db.execute(
    sql.raw(`TRUNCATE TABLE
      activity_events, notifications, suggestions, comments, share_links, invites,
      settlements, expense_shares, expense_payments, expenses, trip_participants,
      packing_items, trip_notes, blocks, days, variants, trip_members,
      trip_user_state, trips, folders, media_assets, user_preferences,
      idempotency_keys, users, fx_rates
      RESTART IDENTITY CASCADE`),
  );

  /** Arjun's id, or the real account's when SEED_OWNER_ID is set. */
  const asOwner = (id: string) => (id === ID.arjun ? ownerId : id);

  let dayTotal = 0;
  let blockTotal = 0;

  await withTransaction(async (tx) => {
    // ── FX ──────────────────────────────────────────────────────────
    await tx.execute(sql`
      INSERT INTO fx_rates (base_currency, quote_currency, rate, as_of) VALUES
        ('JPY','INR',${JPY_TO_INR},'2027-05-18'),
        ('USD','INR','83.00000000','2027-05-18'),
        ('EUR','INR','90.00000000','2027-05-18')
    `);

    // ── People ──────────────────────────────────────────────────────
    await tx.insert(users).values(
      USERS.map((user) => ({
        id: asOwner(user.id),
        email: user.email,
        displayName: user.displayName,
        avatarTone: user.avatarTone,
        homeCity: user.homeCity,
      })),
    );

    // ── Folders ─────────────────────────────────────────────────────
    await tx.insert(folders).values(
      FOLDERS.map((folder) => ({
        id: folder.id,
        ownerId,
        name: folder.name,
        emoji: folder.emoji,
        tone: folder.tone,
        isPinned: folder.isPinned,
        sortOrder: folder.sortOrder,
      })),
    );

    // ── Trips ───────────────────────────────────────────────────────
    const itineraries: Record<string, SeedDay[]> = {
      [ID.kyoto]: KYOTO_DAYS,
      [ID.tokyo]: TOKYO_DAYS,
    };

    let kyotoVariantId = '';

    for (const [index, trip] of TRIPS.entries()) {
      const mainVariantId = newId();
      if (trip.id === ID.kyoto) kyotoVariantId = mainVariantId;

      await tx.insert(trips).values({
        id: trip.id,
        ownerId,
        folderId: trip.folderId,
        title: trip.title,
        subtitle: trip.subtitle,
        destination: trip.destination,
        startDate: trip.startDate,
        endDate: trip.endDate,
        latitude: trip.latitude,
        longitude: trip.longitude,
        status: trip.status as never,
        baseCurrency: 'INR',
        coverHue: trip.coverHue,
        coverHue2: trip.coverHue2,
        isArchived: trip.isArchived,
        mainVariantId,
      });

      // Kyoto carries the three FR-VAR variants; the rest have one. Only the
      // main variant owns days — each variant owns its own tree, which is the
      // thing the prototype faked by sharing one.
      const variantNames =
        trip.id === ID.kyoto ? KYOTO_VARIANTS : ([trip.mainVariantName] as readonly string[]);

      await tx.insert(variants).values(
        variantNames.map((name, position) => ({
          id: position === 0 ? mainVariantId : newId(),
          tripId: trip.id,
          name,
          isMain: position === 0,
          createdBy: ownerId,
        })),
      );

      await tx.insert(tripMembers).values(
        trip.crew.map(([userId, role]) => ({
          tripId: trip.id,
          userId: asOwner(userId),
          role: role as never,
        })),
      );

      // Pinning and ordering are per-user, so they live in trip_user_state
      // rather than on the trip — one member pinning must not reorder anyone
      // else's board (PRD §6.2).
      await tx.execute(sql`
        INSERT INTO trip_user_state (trip_id, user_id, is_pinned, sort_order)
        VALUES (${trip.id}, ${ownerId}, ${trip.isPinned}, ${index})
        ON CONFLICT (trip_id, user_id)
        DO UPDATE SET is_pinned = excluded.is_pinned, sort_order = excluded.sort_order
      `);

      // A trip with an itinerary gets its real days; the rest get empty days
      // spanning their dates, so dayCount is honest and blockCount is 0 —
      // which is exactly the "No bookings yet" readiness case (FR-DASH-07).
      const itinerary = itineraries[trip.id];
      const dayRows: SeedDay[] =
        itinerary ??
        datesBetween(trip.startDate, trip.endDate).map((date, offset) => ({
          number: offset + 1,
          date,
          title: '',
          note: '',
          status: 'PLANNING' as const,
          blocks: [],
        }));

      for (const day of dayRows) {
        const dayId = newId();
        await tx.insert(days).values({
          id: dayId,
          variantId: mainVariantId,
          dayNumber: day.number,
          date: day.date,
          title: day.title,
          note: day.note,
          status: day.status as never,
        });
        dayTotal += 1;

        if (day.blocks.length === 0) continue;

        await tx.insert(blocks).values(
          day.blocks.map((block, position) => ({
            id: newId(),
            dayId,
            type: block.type as never,
            title: block.title,
            timeLabel: block.time ?? '',
            meta: block.meta ?? '',
            notes: block.notes ?? null,
            isConfirmed: Boolean(block.confirmed),
            sortOrder: position,
            createdBy: ownerId,
          })),
        );
        blockTotal += day.blocks.length;
      }
    }

    // ── Ledger, on Kyoto ────────────────────────────────────────────
    const participantIds = [newId(), newId(), newId()];
    await tx.insert(tripParticipants).values([
      { id: participantIds[0]!, tripId: ID.kyoto, userId: ownerId, displayName: 'Arjun', avatarTone: 'sienna', createdBy: ownerId },
      { id: participantIds[1]!, tripId: ID.kyoto, userId: ID.priya, displayName: 'Priya', avatarTone: 'teal', createdBy: ownerId },
      // A placeholder — the FR-SPLIT-01 case, someone with no account who still
      // appears in splits and balances.
      { id: participantIds[2]!, tripId: ID.kyoto, userId: null, displayName: 'Devon (no account)', avatarTone: 'forest', createdBy: ownerId },
    ]);

    const rate = parseRate(JPY_TO_INR);
    const weights = participantIds.map((id) => ({ id, weight: 1n }));

    for (const item of KYOTO_EXPENSES) {
      const expenseId = newId();
      const amountBaseMinor = convertMinor(item.amountMinor, rate, 'JPY', 'INR');

      // Allocate in BOTH currencies — the invariant the DB triggers enforce.
      const { native, base } = allocateBoth(item.amountMinor, amountBaseMinor, weights);

      await tx.insert(expenses).values({
        id: expenseId,
        tripId: ID.kyoto,
        description: item.description,
        amountMinor: item.amountMinor,
        currency: 'JPY',
        fxRateToBase: JPY_TO_INR,
        fxRateSource: 'AUTO',
        amountBaseMinor,
        spentAt: new Date('2027-05-19T12:00:00Z'),
        category: item.category as never,
        splitMethod: 'EQUAL',
        createdBy: ownerId,
      });

      await tx.insert(expensePayments).values({
        id: newId(),
        expenseId,
        participantId: participantIds[item.payer]!,
        amountMinor: item.amountMinor,
        amountBaseMinor,
      });

      await tx.insert(expenseShares).values(
        participantIds.map((participantId) => ({
          expenseId,
          participantId,
          shareAmountMinor: native.get(participantId)!,
          shareAmountBaseMinor: base.get(participantId)!,
        })),
      );
    }

    // Participants on the other trips, so the ledger is reachable everywhere.
    await tx.insert(tripParticipants).values(
      TRIPS.filter((trip) => trip.id !== ID.kyoto).map((trip) => ({
        id: newId(),
        tripId: trip.id,
        userId: ownerId,
        displayName: 'Arjun',
        avatarTone: 'sienna',
        createdBy: ownerId,
      })),
    );

    void kyotoVariantId;
  });

  logger.info(
    {
      users: USERS.length,
      folders: FOLDERS.length,
      trips: TRIPS.length,
      days: dayTotal,
      blocks: blockTotal,
      expenses: KYOTO_EXPENSES.length,
      kyotoTripId: ID.kyoto,
      ownerId,
      ownedByRealAccount: claimed,
    },
    'seed complete',
  );

  if (!claimed) {
    logger.info(
      'set SEED_OWNER_ID=<your supabase user id> to own this data from a real sign-in',
    );
  }
  logger.info('run `npm run token:dev` for a token to paste into /docs');
}

seed()
  .catch((error) => {
    logger.error({ err: error }, 'seed failed');
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
