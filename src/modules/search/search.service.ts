/**
 * Search across trips, blocks, and people.
 *
 * TECHNICAL_DESIGN §5.10, FR-SRCH-05/06. Uses the `search_tsv` generated
 * columns and their GIN indexes.
 *
 * Two rules:
 *   • Every query is scoped by membership BEFORE ranking. Search must never
 *     become an existence oracle for trips the caller cannot see.
 *   • Only the MAIN variant's blocks are searched, so a forked "Budget run"
 *     does not produce a duplicate hit for every block.
 */

import { sql } from 'drizzle-orm';

import { db } from '../../platform/db/index';

export interface SearchResults {
  trips: { id: string; title: string; destination: string; rank: number }[];
  blocks: {
    id: string;
    title: string;
    meta: string;
    tripId: string;
    tripTitle: string;
    variantId: string;
    dayId: string;
    dayNumber: number;
    rank: number;
  }[];
  people: { participantId: string; displayName: string; tripId: string; tripTitle: string }[];
}

export class SearchService {
  async search(userId: string, term: string, limit: number): Promise<SearchResults> {
    // `websearch_to_tsquery` handles quoted phrases and `-exclusions` from raw
    // user input without throwing on syntax the user did not know they typed.
    const query = sql`websearch_to_tsquery('simple', ${term})`;
    const pattern = `%${term}%`;

    const [trips, blocks, people] = await Promise.all([
      db.execute<{ id: string; title: string; destination: string; rank: number }>(sql`
        select t.id, t.title, t.destination, ts_rank(t.search_tsv, ${query}) as rank
          from trips t
          join trip_members tm on tm.trip_id = t.id and tm.user_id = ${userId}
         where t.deleted_at is null
           and t.search_tsv @@ ${query}
         order by rank desc, t.created_at desc
         limit ${limit}
      `),

      db.execute<{
        id: string; title: string; meta: string; trip_id: string; trip_title: string;
        variant_id: string; day_id: string; day_number: number; rank: number;
      }>(sql`
        select b.id, b.title, b.meta,
               t.id as trip_id, t.title as trip_title,
               v.id as variant_id, d.id as day_id, d.day_number,
               ts_rank(b.search_tsv, ${query}) as rank
          from blocks b
          join days d      on d.id = b.day_id
          join variants v  on v.id = d.variant_id
          join trips t     on t.id = v.trip_id
          join trip_members tm on tm.trip_id = t.id and tm.user_id = ${userId}
         where b.deleted_at is null
           and t.deleted_at is null
           and v.is_main
           and b.search_tsv @@ ${query}
         order by rank desc
         limit ${limit}
      `),

      // Names are short, so a plain ILIKE beats full-text here.
      db.execute<{ participant_id: string; display_name: string; trip_id: string; trip_title: string }>(sql`
        select p.id as participant_id, p.display_name, t.id as trip_id, t.title as trip_title
          from trip_participants p
          join trips t on t.id = p.trip_id
          join trip_members tm on tm.trip_id = t.id and tm.user_id = ${userId}
         where t.deleted_at is null
           and p.is_active
           and p.display_name ilike ${pattern}
         limit ${limit}
      `),
    ]);

    return {
      trips: (trips.rows ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        destination: row.destination,
        rank: Number(row.rank),
      })),
      blocks: (blocks.rows ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        meta: row.meta,
        tripId: row.trip_id,
        tripTitle: row.trip_title,
        variantId: row.variant_id,
        dayId: row.day_id,
        dayNumber: Number(row.day_number),
        rank: Number(row.rank),
      })),
      people: (people.rows ?? []).map((row) => ({
        participantId: row.participant_id,
        displayName: row.display_name,
        tripId: row.trip_id,
        tripTitle: row.trip_title,
      })),
    };
  }
}

export const searchService = new SearchService();
