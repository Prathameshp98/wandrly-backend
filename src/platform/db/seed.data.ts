/**
 * The seed fixture set, kept apart from the insert logic that consumes it.
 *
 * PRD §15.3 mandates reusing the prototype's dataset rather than inventing one:
 * "9 trips across 5 folders, all four statuses, a complete 7-day Kyoto
 * itinerary with 40+ blocks, 3 variants, 6 named collaborators, multi-day
 * transport with overnight arrival, and mixed confirmed/unconfirmed states."
 *
 * The point is not volume. Each of those is a layout or logic case that breaks
 * naive code — an overnight flight that crosses midnight, a trip with no
 * bookable blocks whose readiness is 0% rather than NaN, titles long enough to
 * wrap. Building against two tidy trips finds none of them.
 *
 * Ported verbatim from `WANDRLY 2/data.jsx` and `WANDRLY 2/canvas-data.jsx`.
 */

/** Stable ids, so re-seeding produces the same URLs and bookmarks survive. */
export const ID = {
  // People
  arjun: '00000000-0000-7000-8000-00000000a001',
  priya: '00000000-0000-7000-8000-00000000a002',
  sana: '00000000-0000-7000-8000-00000000a003',
  devon: '00000000-0000-7000-8000-00000000a004',
  maya: '00000000-0000-7000-8000-00000000a005',
  felix: '00000000-0000-7000-8000-00000000a006',

  // Folders
  japan: '00000000-0000-7000-8000-00000000b001',
  europe: '00000000-0000-7000-8000-00000000b002',
  work: '00000000-0000-7000-8000-00000000b003',
  wishlist: '00000000-0000-7000-8000-00000000b004',
  archiveFolder: '00000000-0000-7000-8000-00000000b005',

  // Trips
  kyoto: '00000000-0000-7000-8000-00000000c001',
  tokyo: '00000000-0000-7000-8000-00000000c002',
  fuji: '00000000-0000-7000-8000-00000000c003',
  lisbon: '00000000-0000-7000-8000-00000000c004',
  iceland: '00000000-0000-7000-8000-00000000c005',
  amalfi: '00000000-0000-7000-8000-00000000c006',
  singapore: '00000000-0000-7000-8000-00000000c007',
  patagonia: '00000000-0000-7000-8000-00000000c008',
  morocco: '00000000-0000-7000-8000-00000000c009',
} as const;

export const USERS = [
  { id: ID.arjun, email: 'arjun@wandrly.dev', displayName: 'Arjun Mehta', avatarTone: 'sienna', homeCity: 'New Delhi, India' },
  { id: ID.priya, email: 'priya@wandrly.dev', displayName: 'Priya Rao', avatarTone: 'teal', homeCity: 'Mumbai, India' },
  { id: ID.sana, email: 'sana@wandrly.dev', displayName: 'Sana Kapoor', avatarTone: 'gold', homeCity: 'Bengaluru, India' },
  { id: ID.devon, email: 'devon@wandrly.dev', displayName: 'Devon Lang', avatarTone: 'forest', homeCity: 'Singapore' },
  { id: ID.maya, email: 'maya@wandrly.dev', displayName: 'Maya Tendulkar', avatarTone: 'gold', homeCity: 'Lisbon, Portugal' },
  { id: ID.felix, email: 'felix@wandrly.dev', displayName: 'Felix Ostendorf', avatarTone: 'forest', homeCity: 'Berlin, Germany' },
] as const;

export const FOLDERS = [
  { id: ID.japan, name: 'Japan 2027', emoji: '🗾', tone: 'gold', isPinned: true, sortOrder: 0 },
  { id: ID.europe, name: 'Europe Summer ’25', emoji: '🌅', tone: 'teal', isPinned: true, sortOrder: 1 },
  { id: ID.work, name: 'Work Trips', emoji: '💼', tone: 'sienna', isPinned: false, sortOrder: 2 },
  { id: ID.wishlist, name: 'Wishlist', emoji: '🌙', tone: 'sand', isPinned: false, sortOrder: 3 },
  { id: ID.archiveFolder, name: 'Archive', emoji: '🗃', tone: 'forest', isPinned: false, sortOrder: 4 },
] as const;

/**
 * Dates deliberately span past, near-future and far-future so the dashboard
 * exercises all three: `daysToGo` counts down for upcoming trips, is null for
 * past ones, and the spotlight picks the nearest upcoming trip.
 *
 * Japan is the anchor — it is the nearest upcoming set, so Kyoto lands in the
 * spotlight, which is what makes that component testable: it is the only trip
 * with a full itinerary behind its readiness bar. **If Japan 2027 ever falls
 * into the past, bump these years** or the spotlight goes quiet.
 */
export const TRIPS = [
  {
    id: ID.kyoto, folderId: ID.japan, title: 'Kyoto in Spring',
    subtitle: 'Cherry blossoms · machiya stays', destination: 'Kyoto, Japan',
    startDate: '2027-05-18', endDate: '2027-05-24',
    latitude: '35.011600', longitude: '135.768100',
    status: 'CONFIRMED', coverHue: 320, coverHue2: 20,
    isPinned: true, isArchived: false, mainVariantName: 'Slow & cultural',
    crew: [
      [ID.arjun, 'OWNER'], [ID.priya, 'EDITOR'],
      [ID.sana, 'CONTRIBUTOR'], [ID.devon, 'VIEWER'],
    ],
  },
  {
    id: ID.tokyo, folderId: ID.japan, title: 'Tokyo Detour',
    subtitle: 'Shibuya, Yanaka, jazz kissas', destination: 'Tokyo, Japan',
    startDate: '2027-05-25', endDate: '2027-05-28',
    latitude: '35.676200', longitude: '139.650300',
    status: 'PLANNING', coverHue: 280, coverHue2: 240,
    isPinned: true, isArchived: false, mainVariantName: 'Neon & night',
    crew: [[ID.arjun, 'OWNER'], [ID.priya, 'EDITOR']],
  },
  {
    id: ID.fuji, folderId: ID.japan, title: 'Fuji Five Lakes',
    subtitle: 'Onsen weekend before flying out', destination: 'Yamanashi, Japan',
    startDate: '2027-05-29', endDate: '2027-05-31',
    latitude: '35.500800', longitude: '138.778000',
    status: 'DRAFT', coverHue: 200, coverHue2: 180,
    isPinned: true, isArchived: false, mainVariantName: 'Quiet ryokan',
    crew: [[ID.arjun, 'OWNER']],
  },
  {
    id: ID.lisbon, folderId: ID.europe, title: 'Lisbon Long Weekend',
    subtitle: 'Tiles, fado, and pastéis', destination: 'Lisbon, Portugal',
    startDate: '2025-08-14', endDate: '2025-08-18',
    latitude: '38.722300', longitude: '-9.139300',
    // COMPLETED means readiness is always 100%, whatever the blocks say.
    status: 'COMPLETED', coverHue: 30, coverHue2: 80,
    isPinned: false, isArchived: false, mainVariantName: 'Main',
    crew: [[ID.arjun, 'OWNER'], [ID.maya, 'EDITOR']],
  },
  {
    id: ID.iceland, folderId: ID.europe, title: 'Iceland Ring Road',
    subtitle: 'Ten days, one Land Rover', destination: 'Reykjavík → Ring Road',
    startDate: '2025-09-02', endDate: '2025-09-12',
    latitude: '64.146600', longitude: '-21.942600',
    status: 'CONFIRMED', coverHue: 200, coverHue2: 240,
    // Archived, so the archive view and the drag-to-archive target have content.
    isPinned: false, isArchived: true, mainVariantName: 'Clockwise',
    crew: [[ID.arjun, 'OWNER'], [ID.priya, 'EDITOR'], [ID.felix, 'CONTRIBUTOR']],
  },
  {
    id: ID.amalfi, folderId: ID.europe, title: 'Amalfi Coast',
    subtitle: 'Positano slow week', destination: 'Campania, Italy',
    startDate: '2025-06-21', endDate: '2025-06-27',
    latitude: '40.634000', longitude: '14.602700',
    status: 'PLANNING', coverHue: 200, coverHue2: 40,
    isPinned: false, isArchived: false, mainVariantName: 'Cliffside villa',
    crew: [[ID.arjun, 'OWNER'], [ID.priya, 'EDITOR'], [ID.sana, 'CONTRIBUTOR']],
  },
  {
    id: ID.singapore, folderId: ID.work, title: 'Singapore Conference',
    subtitle: 'GovTech summit + 2 free days', destination: 'Singapore',
    startDate: '2027-11-06', endDate: '2027-11-10',
    latitude: '1.352100', longitude: '103.819800',
    status: 'CONFIRMED', coverHue: 280, coverHue2: 220,
    isPinned: false, isArchived: false, mainVariantName: 'Main',
    crew: [[ID.arjun, 'OWNER'], [ID.devon, 'VIEWER']],
  },
  {
    id: ID.patagonia, folderId: ID.wishlist, title: 'Patagonia W-Trek',
    subtitle: 'Five-day Torres del Paine', destination: 'Chilean Patagonia',
    startDate: '2027-12-05', endDate: '2027-12-09',
    latitude: '-50.942300', longitude: '-73.406800',
    status: 'DRAFT', coverHue: 210, coverHue2: 30,
    isPinned: false, isArchived: false, mainVariantName: 'Main',
    crew: [[ID.arjun, 'OWNER']],
  },
  {
    id: ID.morocco, folderId: ID.wishlist,
    // Long title and subtitle on purpose: the trip card has to wrap or ellipsis
    // these without pushing the date row or the avatar stack out of the card.
    title: 'Marrakech, the Atlas Mountains & Essaouira',
    subtitle: 'Souks, riads, mountain passes, and three days on the coast',
    destination: 'Morocco',
    startDate: '2028-03-14', endDate: '2028-03-21',
    latitude: '31.629500', longitude: '-7.981100',
    status: 'DRAFT', coverHue: 30, coverHue2: 60,
    isPinned: false, isArchived: false, mainVariantName: 'Main',
    crew: [[ID.arjun, 'OWNER'], [ID.maya, 'EDITOR']],
  },
] as const;

/** The three variants FR-VAR needs, on the trip that has a real itinerary. */
export const KYOTO_VARIANTS = ['Slow & cultural', 'Family edit', 'Budget run'] as const;

type Block = {
  type: string;
  title: string;
  time?: string;
  meta?: string;
  notes?: string;
  confirmed?: boolean;
};

type Day = {
  number: number;
  date: string;
  title: string;
  note: string;
  status: 'CONFIRMED' | 'PLANNING';
  blocks: Block[];
};

/**
 * The complete Kyoto itinerary — 7 days, 36 blocks, every one of the 11 block
 * types, and mixed confirmed state so readiness is a real fraction rather than
 * 0% or 100%.
 *
 * Note `k7-5`: `20:35 → 02:15+1` is an overnight flight. It is the single most
 * useful row here — anything that parses a start and end time and subtracts
 * them gets a negative duration unless it handles the day rollover.
 */
export const KYOTO_DAYS: Day[] = [
  {
    number: 1, date: '2027-05-18', status: 'CONFIRMED',
    title: 'Arrival & wandering',
    note: 'Long travel day — take it easy. Jet-lag is real.',
    blocks: [
      { type: 'TRANSPORT', title: 'Mumbai → Kansai', time: '02:45 → 13:20', meta: 'Air India · AI 045 · Direct', notes: 'BOM T2 → KIX T1 · 7h 35m', confirmed: true },
      { type: 'TRANSPORT', title: 'Kansai → Kyoto Station', time: '14:30 → 15:45', meta: 'JR Haruka Limited Express', notes: 'Reserved Car 4 · ¥3,640 pp', confirmed: true },
      { type: 'ACCOMMODATION', title: 'Yoshida-sanso Ryokan', time: 'Check-in 16:00', meta: '3 nights · Tatami Suite · Confirmed', notes: '59-1 Yoshida Kaguraokacho, Sakyō Ward', confirmed: true },
      { type: 'RESTAURANT', title: 'Issen Yōshoku', time: '19:30', meta: 'Okonomiyaki · ¥¥', notes: 'Gion · Walk-in OK', confirmed: false },
      { type: 'NOTE', title: 'Onsen at 22:00', notes: "Ryokan's bath closes at 23:00. Take it easy." },
    ],
  },
  {
    number: 2, date: '2027-05-19', status: 'CONFIRMED',
    title: 'Higashiyama temples',
    note: 'Early start — gates open at 6:00, beat the school groups.',
    blocks: [
      { type: 'NOTE', title: 'Alarm set for 5:15', notes: 'Coffee from the ryokan vending machine on the way out.' },
      { type: 'ACTIVITY', title: 'Kiyomizu-dera', time: '06:00 → 08:30', meta: '¥400 entry · 1.2 km walk', notes: 'Famous wooden veranda · Otowa waterfall', confirmed: true },
      { type: 'ACTIVITY', title: 'Sannenzaka & Ninenzaka', time: '09:00 → 11:00', meta: 'Preserved historic streets', notes: 'Tea houses, matcha ice cream, slow wandering', confirmed: false },
      { type: 'MAP_PIN', title: 'Yasaka Pagoda', meta: '34.9988° N, 135.7799° E', notes: 'Best photo spot from Sannenzaka' },
      { type: 'RESTAURANT', title: 'Yagenbori', time: '12:30', meta: 'Obanzai · ¥¥¥', notes: 'Pontocho Alley · Reserved', confirmed: true },
      { type: 'PHOTO', title: '4 photos · Higashiyama', meta: 'Added by Priya', notes: 'Reference shots from last visit' },
      { type: 'RESTAURANT', title: 'Kikunoi', time: '18:30', meta: 'Kaiseki · ¥¥¥¥¥', notes: 'Reserved · 3 stars · ¥38,000 pp', confirmed: true },
    ],
  },
  {
    number: 3, date: '2027-05-20', status: 'CONFIRMED',
    title: 'Bamboo grove & Arashiyama',
    note: '',
    blocks: [
      { type: 'TRANSPORT', title: 'Kyoto → Saga-Arashiyama', time: '08:00 → 08:18', meta: 'JR Sagano Line · ¥240', notes: '17 min · Frequent', confirmed: true },
      { type: 'ACTIVITY', title: 'Arashiyama Bamboo Grove', time: '09:00 → 10:00', meta: 'Free · Best before 10am', notes: 'Walk through Nonomiya shrine on the way', confirmed: true },
      { type: 'ACTIVITY', title: 'Tenryū-ji Temple', time: '10:30 → 12:00', meta: '¥500 garden + ¥300 temple', notes: 'World Heritage · zen garden', confirmed: true },
      { type: 'RESTAURANT', title: 'Shōraian', time: '12:30', meta: 'Yudōfu · ¥¥¥', notes: 'Riverside seating · 1h wait possible', confirmed: false },
      { type: 'ACTIVITY', title: 'Iwatayama Monkey Park', time: '14:00 → 16:00', meta: '¥600 · 20 min uphill walk', notes: 'Macaques + best view of Kyoto', confirmed: true },
      { type: 'LINK', title: 'Hidden cafés in Arashiyama', meta: 'spoon-and-tamago.com', notes: 'Saved by Sana · 14 spots' },
    ],
  },
  {
    number: 4, date: '2027-05-21', status: 'PLANNING',
    title: 'Nishiki & the geisha district',
    note: 'Switch hotels today — store bags at Kyoto Station.',
    blocks: [
      { type: 'ACCOMMODATION', title: 'Hotel The Mitsui Kyoto', time: 'Check-in 15:00', meta: '3 nights · Garden Wing · Confirmed', notes: 'Karasuma-Oike · ryokan within hotel', confirmed: true },
      { type: 'ACTIVITY', title: 'Nishiki Market', time: '10:00 → 12:30', meta: "\"Kyoto's kitchen\"", notes: '5 blocks · 130 shops · sample everything', confirmed: false },
      { type: 'RESTAURANT', title: 'Hafuu Honten', time: '13:00', meta: 'Wagyu · ¥¥¥', notes: 'Reserved · beef course ¥9,800', confirmed: true },
      { type: 'BUDGET', title: 'Souvenir budget', meta: '¥15,000 · misc', notes: 'Cap on the day · split 4 ways' },
      { type: 'ACTIVITY', title: 'Gion walking', time: '16:00 → 18:00', meta: 'Hanami-koji + Shirakawa', notes: 'Maybe spot a geiko en route to ozashiki', confirmed: false },
      { type: 'TICKET', title: 'Gion Corner Cultural Show', time: '18:00 → 18:50', meta: 'Tickets · ¥5,500 × 4', notes: 'Tea ceremony · gagaku · kyogen', confirmed: true },
    ],
  },
  {
    number: 5, date: '2027-05-22', status: 'PLANNING',
    title: 'Fushimi Inari at dawn',
    note: 'Alarm 04:30. Worth it. Trust.',
    blocks: [
      { type: 'TRANSPORT', title: 'Taxi to Fushimi Inari', time: '05:00 → 05:20', meta: '¥1,800 · prebook the night before', notes: 'JR after sunrise is fine on the way back', confirmed: false },
      { type: 'ACTIVITY', title: 'Fushimi Inari Shrine', time: '05:30 → 09:00', meta: 'Free · 4 km loop', notes: '10,000 torii gates · summit takes 2h round trip', confirmed: true },
      { type: 'PHOTO', title: '12 photos · dawn torii', meta: 'Saved earlier', notes: 'Set for the postcard print idea' },
      { type: 'RESTAURANT', title: 'Vermillion Café', time: '09:30', meta: 'Coffee · ¥', notes: 'At foot of the shrine · pour-overs', confirmed: false },
      { type: 'ACTIVITY', title: 'Tōfuku-ji & garden', time: '11:00 → 13:00', meta: '¥600 · 20 min from Fushimi', notes: 'Hojo zen garden · maple corridor', confirmed: true },
    ],
  },
  {
    number: 6, date: '2027-05-23', status: 'PLANNING',
    title: 'Day trip · Nara',
    note: '',
    blocks: [
      { type: 'TRANSPORT', title: 'Kyoto → Nara', time: '09:00 → 09:45', meta: 'JR Miyakoji Rapid · ¥720', notes: 'IC card OK · runs every 20 min', confirmed: false },
      { type: 'ACTIVITY', title: 'Tōdai-ji & Great Buddha', time: '10:30 → 12:30', meta: '¥600 entry', notes: 'Largest wooden building in the world', confirmed: true },
      { type: 'ACTIVITY', title: 'Nara Park · deer', time: '13:00 → 14:30', meta: 'Free · ¥200 for shika senbei', notes: '1,200 wild sika deer · bow back to them', confirmed: false },
      { type: 'RESTAURANT', title: 'Wamiya', time: '14:30', meta: 'Somen · ¥¥', notes: 'No reservations · 30 min queue', confirmed: false },
      { type: 'MAP_PIN', title: 'Kasuga-taisha Shrine', meta: '34.6810° N, 135.8485° E', notes: '3,000 stone lanterns · evening visit' },
      { type: 'TRANSPORT', title: 'Nara → Kyoto', time: '18:00 → 18:45', meta: 'JR rapid · same ticket', confirmed: false },
    ],
  },
  {
    number: 7, date: '2027-05-24', status: 'PLANNING',
    title: 'Slow morning & departure',
    note: 'Last day — keep it gentle. Flight is overnight.',
    blocks: [
      { type: 'RESTAURANT', title: '% Arabica Higashiyama', time: '09:00', meta: 'Coffee · ¥', notes: 'The iconic location · 15 min queue', confirmed: false },
      { type: 'ACTIVITY', title: 'Yasaka shrine + Maruyama park', time: '10:00 → 11:30', meta: 'Free · 20 min walk', notes: 'Slow loop · pick up gifts on the way', confirmed: false },
      { type: 'ACCOMMODATION', title: 'Check-out · Mitsui', time: '11:30', meta: 'Bag storage until 16:00 available', confirmed: true },
      { type: 'TRANSPORT', title: 'Kyoto → Kansai (KIX)', time: '16:30 → 17:45', meta: 'JR Haruka · reserved', confirmed: true },
      // The overnight case. `+1` marks arrival on the following day.
      { type: 'TRANSPORT', title: 'Kansai → Mumbai', time: '20:35 → 02:15+1', meta: 'Air India AI 046', notes: 'KIX T1 → BOM T2 · 8h 40m', confirmed: true },
      { type: 'VIDEO', title: 'Kyoto in 4 minutes', meta: 'Saved from YouTube', notes: 'The reference reel we planned half of this from' },
    ],
  },
];

/** A handful of blocks on a second trip, so day counts are not all 0 or 36. */
export const TOKYO_DAYS: Day[] = [
  {
    number: 1, date: '2027-05-25', status: 'PLANNING',
    title: 'Shinkansen up & Shinjuku',
    note: '',
    blocks: [
      { type: 'TRANSPORT', title: 'Kyoto → Tokyo · Shinkansen Nozomi', time: '09:00 → 11:15', meta: 'Reserved · ¥14,170', confirmed: true },
      { type: 'ACCOMMODATION', title: 'Hotel Granbell Shinjuku', time: 'Check-in 15:00', meta: '3 nights · West Wing', confirmed: true },
      { type: 'RESTAURANT', title: 'Tonkatsu Maisen', time: '13:30', meta: 'Aoyama · ¥¥', confirmed: false },
    ],
  },
  {
    number: 2, date: '2027-05-26', status: 'PLANNING',
    title: 'Yanaka & jazz kissas',
    note: 'Record shops in the afternoon.',
    blocks: [
      { type: 'ACTIVITY', title: 'Yanaka Ginza', time: '10:00 → 12:00', meta: 'Old-town shotengai', confirmed: false },
      { type: 'LINK', title: 'Tokyo jazz kissa map', meta: 'tokyojazzjoints.com', notes: 'Twelve listening bars, sorted by district' },
      { type: 'RESTAURANT', title: 'Kissa Sakaiki', time: '19:00', meta: 'Jazz kissa · ¥¥', notes: 'No talking during records', confirmed: false },
    ],
  },
];

/** Expenses that exercise the ledger, all in JPY against an INR base. */
export const KYOTO_EXPENSES = [
  { description: 'Yoshida-sanso · 3 nights', amountMinor: 86_400n, category: 'ACCOMMODATION', payer: 0 },
  { description: 'Kikunoi kaiseki', amountMinor: 152_000n, category: 'FOOD', payer: 1 },
  { description: 'JR Haruka × 3', amountMinor: 10_920n, category: 'TRANSPORT', payer: 0 },
  { description: 'Monkey park tickets', amountMinor: 1_800n, category: 'ACTIVITY', payer: 2 },
  { description: 'Konbini supplies', amountMinor: 3_340n, category: 'GROCERIES', payer: 1 },
  { description: 'Gion Corner × 4', amountMinor: 22_000n, category: 'ACTIVITY', payer: 0 },
] as const;
