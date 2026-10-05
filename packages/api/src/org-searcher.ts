import type { Client } from "@libsql/client";
import type { OrgSearchRecord, SourceFile } from "@nonprofits/core";
import { rowsOf } from "./rows.ts";

interface MatchRow {
  ein: string;
  name: string;
  city: string | null;
  state: string | null;
  subsection: string | null;
  bmf_run_id: number | null;
  in_pub78: 0 | 1;
}

interface RunRow {
  id: number;
  source: "bmf" | "pub78";
  file: string;
  released_at: string;
  fetched_at: string;
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
SELECT o.ein, o.name, o.city, o.state, o.subsection, o.bmf_run_id, o.in_pub78
FROM (
  SELECT rowid, rank AS score FROM orgs_fts WHERE orgs_fts MATCH ?1 LIMIT ${MAX_CANDIDATES}
) m
JOIN orgs o ON o.ein = printf('%09d', m.rowid) AND o.name IS NOT NULL
ORDER BY o.in_pub78 DESC, o.bmf_run_id IS NULL, m.score, m.rowid
LIMIT ?2`;

/**
 * Every BMF run, since each region file is its own run and a match cites the
 * one listing it, plus the latest Pub 78 run, which `in_pub78` is as of: a
 * data database is built fresh each month, so a handful of rows.
 */
const SOURCE_RUNS_SQL = `
SELECT id, source, file_url AS file, released_at, fetched_at
FROM import_runs WHERE source = 'bmf'
UNION ALL
SELECT id, source, file_url, released_at, fetched_at
FROM import_runs WHERE id = (SELECT max(id) FROM import_runs WHERE source = 'pub78')`;

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
  const [matches, runs] = await db.batch(
    [
      { sql: SEARCH_SQL, args: [matchExpression(words), limit] },
      SOURCE_RUNS_SQL,
    ],
    "read",
  );
  const bmfRuns = new Map<number, SourceFile>();
  let pub78Run: SourceFile | undefined;
  for (const run of rowsOf<RunRow>(runs)) {
    const source = {
      file: run.file,
      releasedAt: run.released_at,
      fetchedAt: run.fetched_at,
    };
    if (run.source === "pub78") pub78Run = source;
    else bmfRuns.set(run.id, source);
  }
  return rowsOf<MatchRow>(matches).map((row) => {
    const bmfRun =
      row.bmf_run_id === null ? undefined : bmfRuns.get(row.bmf_run_id);
    return {
      ein: row.ein,
      name: row.name,
      city: row.city,
      state: row.state,
      bmf:
        row.subsection !== null && bmfRun
          ? { subsection: row.subsection, source: bmfRun }
          : null,
      pub78: pub78Run ? { listed: row.in_pub78 === 1, source: pub78Run } : null,
    };
  });
}
