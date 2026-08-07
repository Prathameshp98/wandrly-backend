/**
 * Development seed — the prototype's Kyoto dataset.
 *
 * TECHNICAL_DESIGN §13.2: "The seed script must load the prototype's actual
 * dataset. It is unusually good test data."
 *
 * Notably it is **entirely JPY**, a zero-decimal currency, so the rounding edge
 * cases that break naive money code are exercised from the first day of
 * development rather than discovered in production.
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
import { isProduction } from '../config/env';

const JPY_TO_INR = '0.58000000';

/** Stable ids so re-seeding produces the same URLs. */
const ID = {
  arjun: '00000000-0000-7000-8000-00000000a001',
  priya: '00000000-0000-7000-8000-00000000a002',
  sana: '00000000-0000-7000-8000-00000000a003',
  japanFolder: '00000000-0000-7000-8000-00000000b001',
  kyoto: '00000000-0000-7000-8000-00000000c001',
  tokyo: '00000000-0000-7000-8000-00000000c002',
} as const;

const KYOTO_DAYS = [
  {
    number: 1,
    date: '2026-05-18',
    title: 'Arrival & wandering',
    note: 'Long travel day — take it easy. Jet-lag is real.',
    blocks: [
      ['TRANSPORT', 'Mumbai → Kansai', '02:45 → 13:20', 'Air India · AI 045 · Direct', true],
      ['TRANSPORT', 'Kansai → Kyoto Station', '14:30 → 15:45', 'JR Haruka Limited Express', true],
      ['ACCOMMODATION', 'Yoshida-sanso Ryokan', 'Check-in 16:00', '3 nights · Tatami Suite', true],
      ['RESTAURANT', 'Issen Yōshoku', '19:30', 'Okonomiyaki · ¥¥ · Gion', false],
      ['NOTE', 'Onsen at 22:00', '', "Ryokan's bath closes at 23:00", false],
    ],
  },
  {
    number: 2,
    date: '2026-05-19',
    title: 'Higashiyama temples',
    note: 'Early start — gates open at 6:00, beat the school groups.',
    blocks: [
      ['ACTIVITY', 'Kiyomizu-dera', '06:00 → 08:30', '¥400 entry · 1.2 km walk', true],
      ['ACTIVITY', 'Sannenzaka & Ninenzaka', '09:00 → 11:00', 'Preserved historic streets', false],
      ['MAP_PIN', 'Yasaka Pagoda', '', '34.9988° N, 135.7799° E', false],
      ['RESTAURANT', 'Yagenbori', '12:30', 'Obanzai · ¥¥¥ · Pontocho Alley', true],
      ['PHOTO', '4 photos · Higashiyama', '', 'Reference shots from last visit', false],
      ['RESTAURANT', 'Kikunoi', '18:30', 'Kaiseki · ¥¥¥¥¥ · 3 stars', true],
    ],
  },
  {
    number: 3,
    date: '2026-05-20',
    title: 'Bamboo grove & Arashiyama',
    note: '',
    blocks: [
      ['TRANSPORT', 'Kyoto → Saga-Arashiyama', '08:00 → 08:18', 'JR Sagano Line · ¥240', true],
      ['ACTIVITY', 'Arashiyama Bamboo Grove', '09:00 → 10:00', 'Free · Best before 10am', true],
      ['ACTIVITY', 'Tenryū-ji Temple', '10:30 → 12:00', '¥500 garden + ¥300 temple', true],
      ['RESTAURANT', 'Shōraian', '12:30', 'Yudōfu · ¥¥¥ · Riverside', false],
      ['TICKET', 'Iwatayama Monkey Park', '14:00 → 16:00', '¥600 · 20 min uphill', true],
      ['LINK', 'Arashiyama walking guide', '', 'japan-guide.com', false],
      ['BUDGET', 'Day 3 cash allowance', '', '¥15,000 for the group', false],
      ['VIDEO', 'Bamboo grove at dawn', '', 'Walking tour reference', false],
    ],
  },
] as const;

/** Expenses that exercise the ledger, all in JPY against an INR base. */
const KYOTO_EXPENSES = [
  { description: 'Yoshida-sanso · 3 nights', amountMinor: 86_400n, category: 'ACCOMMODATION', payer: 0 },
  { description: 'Kikunoi kaiseki', amountMinor: 152_000n, category: 'FOOD', payer: 1 },
  { description: 'JR Haruka × 3', amountMinor: 10_920n, category: 'TRANSPORT', payer: 0 },
  { description: 'Monkey park tickets', amountMinor: 1_800n, category: 'ACTIVITY', payer: 2 },
  { description: 'Konbini supplies', amountMinor: 3_340n, category: 'GROCERIES', payer: 1 },
] as const;

async function seed(): Promise<void> {
  if (isProduction) {
    throw new Error('Refusing to seed a production database');
  }

  logger.info('seeding development data');

  await db.execute(
    sql.raw(`TRUNCATE TABLE
      activity_events, notifications, suggestions, comments, share_links, invites,
      settlements, expense_shares, expense_payments, expenses, trip_participants,
      packing_items, trip_notes, blocks, days, variants, trip_members,
      trip_user_state, trips, folders, media_assets, user_preferences,
      idempotency_keys, users, fx_rates
      RESTART IDENTITY CASCADE`),
  );

  await withTransaction(async (tx) => {
    // ── FX ──────────────────────────────────────────────────────────
    await tx.execute(sql`
      INSERT INTO fx_rates (base_currency, quote_currency, rate, as_of) VALUES
        ('JPY','INR',${JPY_TO_INR},'2026-05-18'),
        ('USD','INR','83.00000000','2026-05-18'),
        ('EUR','INR','90.00000000','2026-05-18')
    `);

    // ── People ──────────────────────────────────────────────────────
    await tx.insert(users).values([
      { id: ID.arjun, email: 'arjun@wandrly.dev', displayName: 'Arjun Mehta', avatarTone: 'sienna', homeCity: 'New Delhi, India' },
      { id: ID.priya, email: 'priya@wandrly.dev', displayName: 'Priya Rao', avatarTone: 'teal' },
      { id: ID.sana, email: 'sana@wandrly.dev', displayName: 'Sana Kapoor', avatarTone: 'gold' },
    ]);

    await tx.insert(folders).values({
      id: ID.japanFolder,
      ownerId: ID.arjun,
      name: 'Japan 2026',
      emoji: '🗾',
      tone: 'gold',
      isPinned: true,
    });

    // ── Kyoto trip ──────────────────────────────────────────────────
    const kyotoVariantId = newId();

    await tx.insert(trips).values({
      id: ID.kyoto,
      ownerId: ID.arjun,
      folderId: ID.japanFolder,
      title: 'Kyoto in Spring',
      subtitle: 'Cherry blossoms · machiya stays',
      destination: 'Kyoto, Japan',
      startDate: '2026-05-18',
      endDate: '2026-05-24',
      latitude: '35.011600',
      longitude: '135.768100',
      status: 'CONFIRMED',
      baseCurrency: 'INR',
      coverHue: 320,
      coverHue2: 20,
      mainVariantId: kyotoVariantId,
    });

    // Three variants — but only the main one carries days, matching the model
    // where each variant owns its own tree (the prototype faked this).
    await tx.insert(variants).values([
      { id: kyotoVariantId, tripId: ID.kyoto, name: 'Slow & cultural', isMain: true, createdBy: ID.arjun },
      { id: newId(), tripId: ID.kyoto, name: 'Family edit', isMain: false, createdBy: ID.arjun },
      { id: newId(), tripId: ID.kyoto, name: 'Budget run', isMain: false, createdBy: ID.arjun },
    ]);

    await tx.insert(tripMembers).values([
      { tripId: ID.kyoto, userId: ID.arjun, role: 'OWNER' },
      { tripId: ID.kyoto, userId: ID.priya, role: 'EDITOR' },
      { tripId: ID.kyoto, userId: ID.sana, role: 'CONTRIBUTOR' },
    ]);

    for (const day of KYOTO_DAYS) {
      const dayId = newId();
      await tx.insert(days).values({
        id: dayId,
        variantId: kyotoVariantId,
        dayNumber: day.number,
        date: day.date,
        title: day.title,
        note: day.note,
        status: 'CONFIRMED',
      });

      await tx.insert(blocks).values(
        day.blocks.map(([type, title, timeLabel, meta, confirmed], index) => ({
          id: newId(),
          dayId,
          type: type as never,
          title,
          timeLabel,
          meta,
          isConfirmed: Boolean(confirmed),
          sortOrder: index,
          createdBy: ID.arjun,
        })),
      );
    }

    // ── Ledger ──────────────────────────────────────────────────────
    const participantIds = [newId(), newId(), newId()];
    await tx.insert(tripParticipants).values([
      { id: participantIds[0]!, tripId: ID.kyoto, userId: ID.arjun, displayName: 'Arjun', avatarTone: 'sienna', createdBy: ID.arjun },
      { id: participantIds[1]!, tripId: ID.kyoto, userId: ID.priya, displayName: 'Priya', avatarTone: 'teal', createdBy: ID.arjun },
      // A placeholder — the FR-SPLIT-01 case, someone with no account.
      { id: participantIds[2]!, tripId: ID.kyoto, userId: null, displayName: 'Devon (no account)', avatarTone: 'forest', createdBy: ID.arjun },
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
        spentAt: new Date('2026-05-19T12:00:00Z'),
        category: item.category as never,
        splitMethod: 'EQUAL',
        createdBy: ID.arjun,
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

    // ── A second trip, for dashboard/list testing ───────────────────
    const tokyoVariantId = newId();
    await tx.insert(trips).values({
      id: ID.tokyo,
      ownerId: ID.arjun,
      folderId: ID.japanFolder,
      title: 'Tokyo Detour',
      subtitle: 'Shibuya, Yanaka, jazz kissas',
      destination: 'Tokyo, Japan',
      startDate: '2026-05-25',
      endDate: '2026-05-28',
      status: 'PLANNING',
      baseCurrency: 'INR',
      mainVariantId: tokyoVariantId,
    });
    await tx.insert(variants).values({
      id: tokyoVariantId, tripId: ID.tokyo, name: 'Neon & night', isMain: true, createdBy: ID.arjun,
    });
    await tx.insert(tripMembers).values({ tripId: ID.tokyo, userId: ID.arjun, role: 'OWNER' });
    await tx.insert(tripParticipants).values({
      id: newId(), tripId: ID.tokyo, userId: ID.arjun, displayName: 'Arjun', createdBy: ID.arjun,
    });
  });

  const blockCount = KYOTO_DAYS.reduce((sum, day) => sum + day.blocks.length, 0);
  logger.info(
    {
      users: 3,
      trips: 2,
      days: KYOTO_DAYS.length,
      blocks: blockCount,
      expenses: KYOTO_EXPENSES.length,
      kyotoTripId: ID.kyoto,
      arjunUserId: ID.arjun,
    },
    'seed complete',
  );
  logger.info('run `npm run token:dev` for a token to paste into /docs');
}

seed()
  .catch((error) => {
    logger.error({ err: error }, 'seed failed');
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
