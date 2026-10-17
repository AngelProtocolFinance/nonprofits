import { type Client, LibsqlError } from "@libsql/client";
import type { OrgSearchRecord, SourceFile } from "@nonprofits/core";
import { FILING_SIZE_INDEX, matchExpression, searchSql } from "@nonprofits/db";
import { rowsOf } from "./rows.ts";

interface MatchRow {
  ein: string;
  name: string;
  city: string | null;
  state: string | null;
  subsection: string | null;
  ruling_date: string | null;
  bmf_run_id: number | null;
  in_pub78: 0 | 1;
  revocation_date: string | null;
  reinstatement_date: string | null;
}

interface RunRow {
  id: number;
  source: "bmf" | "pub78" | "revocation";
  file: string;
  released_at: string;
  fetched_at: string;
}

function lacksSizeIndex(error: unknown): boolean {
  return (
    error instanceof LibsqlError &&
    error.message.includes(`no such index: ${FILING_SIZE_INDEX}`)
  );
}

/**
 * Every BMF run, since each region file is its own run and a match cites the
 * one listing it, plus the latest Pub 78 run, which `in_pub78` is as of, and
 * the latest revocation run, which the revocation dates are as of. One extra
 * indexed row, not a query per match: a data database is built fresh each
 * month, so a handful of rows.
 */
const SOURCE_RUNS_SQL = `
SELECT id, source, file_url AS file, released_at, fetched_at
FROM import_runs WHERE source = 'bmf'
UNION ALL
SELECT id, source, file_url, released_at, fetched_at
FROM import_runs WHERE id = (SELECT max(id) FROM import_runs WHERE source = 'pub78')
UNION ALL
SELECT id, source, file_url, released_at, fetched_at
FROM import_runs WHERE id = (SELECT max(id) FROM import_runs WHERE source = 'revocation')`;

/**
 * Part of every search cache key: bump it with any change to what
 * `searchNames` returns for the same words on the same build, its record
 * shape or its order, or a deploy serves the old answer for up to an hour.
 */
export const SEARCH_RECORD_VERSION = 3;

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
  let revocationRun: SourceFile | undefined;
  for (const run of rowsOf<RunRow>(runs)) {
    const source = {
      file: run.file,
      releasedAt: run.released_at,
      fetchedAt: run.fetched_at,
    };
    if (run.source === "pub78") pub78Run = source;
    else if (run.source === "revocation") revocationRun = source;
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
          ? {
              subsection: row.subsection,
              rulingDate: row.ruling_date,
              source: bmfRun,
            }
          : null,
      pub78: pub78Run ? { listed: row.in_pub78 === 1, source: pub78Run } : null,
      revocation: revocationRun
        ? {
            revokedOn: row.revocation_date,
            reinstatedOn: row.reinstatement_date,
            source: revocationRun,
          }
        : null,
    };
  });
}
