import { type Client, LibsqlError } from "@libsql/client";
import type { OrgSearchRecord, SourceFile } from "@nonprofits/core";
import { FILING_SIZE_INDEX } from "@nonprofits/db";
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
 * Ranking reads each candidate's FTS entry, org row and filing size, so a
 * word in 912k names (`inc`) would read them all: only this many matches, in
 * EIN order, are ranked, and a broad word's best match can fall past them.
 * The service-wide daily ceilings in quota.ts are sized on it.
 */
const MAX_CANDIDATES = 1_000;

/**
 * Of the first MAX_CANDIDATES matches in EIN order: orgs in Pub 78 first,
 * then the rest of the current BMF, then orgs the BMF no longer lists; bm25
 * orders each tier. Every match holds every word, so
 * the tiers outweigh bm25's preference for short names: a dropped chapter
 * named AMERICAN RED CROSS would otherwise outscore the national org. At an
 * equal score the larger org leads, so UNITED WAY WORLDWIDE tops its chapters:
 * its latest filing's revenue, then its assets, a missing figure or filing
 * last; EIN breaks the ties left. `united way` ties across the whole candidate
 * window, and revenue sits after mission and activity_summary, so the primary
 * key would read both texts per candidate and time out on Turso. INDEXED BY
 * the covering size index reads only the figures; without it the unanalyzed
 * planner picks the primary key even when the index exists. A database built
 * before the index still answers through the primary key.
 */
function searchSql(indexed: boolean): string {
  const filings = indexed
    ? `LEFT JOIN filings f INDEXED BY ${FILING_SIZE_INDEX} ON f.ein = o.ein`
    : "LEFT JOIN filings f ON f.ein = o.ein";
  return `
SELECT o.ein, o.name, o.city, o.state, o.subsection, o.bmf_run_id, o.in_pub78
FROM (
  SELECT rowid, rank AS score FROM orgs_fts WHERE orgs_fts MATCH ?1 LIMIT ${MAX_CANDIDATES}
) m
JOIN orgs o ON o.ein = printf('%09d', m.rowid) AND o.name IS NOT NULL
${filings}
ORDER BY o.in_pub78 DESC, o.bmf_run_id IS NULL, m.score,
  f.total_revenue DESC NULLS LAST, f.total_assets_eoy DESC NULLS LAST, m.rowid
LIMIT ?2`;
}

function lacksSizeIndex(error: unknown): boolean {
  return (
    error instanceof LibsqlError &&
    error.message.includes(`no such index: ${FILING_SIZE_INDEX}`)
  );
}

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

/**
 * Part of every search cache key: bump it with any change to what
 * `searchNames` returns for the same words on the same build, its record
 * shape or its order, or a deploy serves the old answer for up to an hour.
 */
export const SEARCH_RECORD_VERSION = 2;

/**
 * The match query and the source-run query in one round trip. A database
 * built before `filings_size` fails the indexed join at prepare time, before
 * it reads any filing; the same batch then runs without the index. The next
 * search tries the index again, so creating it starts being used without a
 * new process.
 */
async function matchBatch(db: Client, words: string[], limit: number) {
  const args = [matchExpression(words), limit] as const;
  try {
    return await db.batch(
      [{ sql: searchSql(true), args: [...args] }, SOURCE_RUNS_SQL],
      "read",
    );
  } catch (error) {
    if (!lacksSizeIndex(error)) throw error;
    return db.batch(
      [{ sql: searchSql(false), args: [...args] }, SOURCE_RUNS_SQL],
      "read",
    );
  }
}

/** Each word as a quoted FTS5 string, so no word reads as FTS5 syntax. */
function matchExpression(words: string[]): string {
  return words.map((w) => `"${w.replaceAll('"', '""')}"`).join(" ");
}

/** Detail lines of the plan behind `searchNames`, in order. */
export async function searchMatchPlan(
  db: Client,
  words: string[],
  limit: number,
): Promise<string[]> {
  try {
    return await explainMatch(db, true, words, limit);
  } catch (error) {
    if (!lacksSizeIndex(error)) throw error;
    return explainMatch(db, false, words, limit);
  }
}

async function explainMatch(
  db: Client,
  indexed: boolean,
  words: string[],
  limit: number,
): Promise<string[]> {
  const plan = await db.execute({
    sql: `EXPLAIN QUERY PLAN ${searchSql(indexed)}`,
    args: [matchExpression(words), limit],
  });
  return plan.rows.map((row) => String(row.detail));
}

/** Searches org names in one round trip to the data database: `OrgSearcher.search`. */
export async function searchNames(
  db: Client,
  words: string[],
  limit: number,
): Promise<OrgSearchRecord[]> {
  const [matches, runs] = await matchBatch(db, words, limit);
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
