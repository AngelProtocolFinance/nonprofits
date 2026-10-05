import type { Client } from "@libsql/client";
import type { OrgSearchRecord } from "@nonprofits/core";
import { rowsOf } from "./rows.ts";

interface MatchRow {
  ein: string;
  name: string;
  city: string | null;
  state: string | null;
  subsection: string | null;
  in_pub78: 0 | 1;
}

/**
 * Ranking reads each candidate's indexed length and org row, so a word in
 * 912k names (`inc`) would read them all: only this many matches, in EIN
 * order, are ranked.
 */
const MAX_CANDIDATES = 10_000;

/**
 * Orgs in Pub 78 first, then the rest of the current BMF, then orgs the BMF
 * no longer lists; bm25 orders each tier and EIN breaks ties. Every match
 * holds every word, so the tiers outweigh bm25's preference for short names:
 * a dropped chapter named AMERICAN RED CROSS would otherwise outscore the
 * national org.
 */
const SEARCH_SQL = `
SELECT o.ein, o.name, o.city, o.state, o.subsection, o.in_pub78
FROM (
  SELECT rowid, rank AS score FROM orgs_fts WHERE orgs_fts MATCH ?1 LIMIT ${MAX_CANDIDATES}
) m
JOIN orgs o ON o.ein = printf('%09d', m.rowid) AND o.name IS NOT NULL
ORDER BY o.in_pub78 DESC, o.bmf_run_id IS NULL, m.score, m.rowid
LIMIT ?2`;

const PUB78_IMPORTED_SQL = `
SELECT EXISTS (SELECT 1 FROM import_runs WHERE source = 'pub78') AS imported`;

/** Each word as a quoted FTS5 string, so no word reads as FTS5 syntax. */
function matchExpression(words: string[]): string {
  return words.map((w) => `"${w.replaceAll('"', '""')}"`).join(" ");
}

/** Searches org names in one round trip to the data database: `OrgSearcher.search`. */
export async function searchNames(
  db: Client,
  words: string[],
  limit: number,
): Promise<OrgSearchRecord[]> {
  const [matches, pub78] = await db.batch(
    [
      { sql: SEARCH_SQL, args: [matchExpression(words), limit] },
      PUB78_IMPORTED_SQL,
    ],
    "read",
  );
  const pub78Imported = rowsOf<{ imported: 0 | 1 }>(pub78)[0]?.imported === 1;
  return rowsOf<MatchRow>(matches).map((row) => ({
    ein: row.ein,
    name: row.name,
    city: row.city,
    state: row.state,
    bmf: row.subsection === null ? null : { subsection: row.subsection },
    pub78: pub78Imported ? { listed: row.in_pub78 === 1 } : null,
  }));
}
