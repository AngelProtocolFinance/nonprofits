import type { Client, InArgs } from "@libsql/client";
import { FILING_SIZE_INDEX, matchExpression, searchSql } from "@nonprofits/db";
import { errorMessage } from "./error-message.ts";

/** How long warm-up may run before the pointer switches anyway. */
export const WARMUP_BUDGET_MS = 600_000;

/**
 * How long one warm-up query may run. `@libsql/client`'s `Client.execute`
 * takes no abort signal (`Config.timeout` is only the local SQLITE_BUSY
 * wait), so a query that loses this race is left running and the next one
 * starts. Its promise is caught, so the loss is not an unhandled rejection.
 */
export const WARMUP_QUERY_TIMEOUT_MS = 60_000;

/** Common name searches, warmed in this order, ahead of the index reads. */
export const WARMUP_TERMS = [
  "united way",
  "church",
  "goodwill",
  "red cross",
  "salvation army",
  "catholic charities",
  "foundation",
  "food bank",
  "boys girls club",
  "habitat humanity",
  "ymca",
  "school",
  "hospital",
  "ministries",
  "baptist",
  "lutheran",
  "methodist",
  "little league",
  "lions club",
  "rotary",
  "pta",
  "humane society",
  "scholarship fund",
  "community foundation",
  "veterans",
  "fire department",
  "volunteer fire",
  "association",
  "inc",
  "trust",
  "community",
  "center",
  "council",
  "society",
  "club",
  "american",
  "national",
  "youth",
  "health",
  "education",
] as const;

/**
 * One row through the index, not a count of the table, for both reads below.
 * A count scans every row and keeps scanning after it loses its race, past
 * the pointer switch.
 */
const FILINGS_SIZE_SQL = `SELECT total_revenue FROM filings INDEXED BY ${FILING_SIZE_INDEX} LIMIT 1`;

/** SQLite's automatic index on `orgs.ein`, the primary key. */
const ORGS_KEY_SQL =
  "SELECT ein FROM orgs INDEXED BY sqlite_autoindex_orgs_1 LIMIT 1";

export interface WarmupQuery {
  label: string;
  ok: boolean;
  seconds: number;
  warning?: string;
}

export interface WarmupReport {
  queries: WarmupQuery[];
  /** Queries not started because the budget was already spent. */
  skipped: number;
  seconds: number;
  /** The summary line, also logged. */
  summary: string;
  /** Warning lines, empty when every started query finished. */
  warnings: string[];
}

export interface WarmupOptions {
  db: Client;
  log?: (line: string) => void;
  signal?: AbortSignal;
  budgetMs?: number;
  queryTimeoutMs?: number;
  now?: () => number;
}

interface Query {
  label: string;
  sql: string;
  args: InArgs;
}

/**
 * The search SQL the api runs, then one row through each index. Each read
 * opens the index and walks it for one row, then stops, unlike the counts
 * they replaced. A missing index warns.
 */
function queries(): Query[] {
  const searches = WARMUP_TERMS.map((term) => ({
    label: term,
    sql: searchSql(true),
    args: [matchExpression(term.split(" ")), 1] as InArgs,
  }));
  return [
    ...searches,
    { label: "filings_size", sql: FILINGS_SIZE_SQL, args: [] },
    { label: "orgs key", sql: ORGS_KEY_SQL, args: [] },
  ];
}

/**
 * Runs the searches, then one row through each index, on a database that is
 * not served yet. Each read opens the index and walks it for one row, then
 * stops, unlike the counts they replaced. A missing index warns. A query
 * that fails or runs out its own time is a warning. Once `budgetMs` is spent,
 * the rest are not started. Rejects only when `signal` aborts, which is a
 * stop, not a warning.
 */
export async function warmUploadedDatabase(
  options: WarmupOptions,
): Promise<WarmupReport> {
  const {
    db,
    log = () => {},
    signal,
    budgetMs = WARMUP_BUDGET_MS,
    queryTimeoutMs = WARMUP_QUERY_TIMEOUT_MS,
    now = () => performance.now(),
  } = options;
  const plan = queries();
  const started = now();
  const ran: WarmupQuery[] = [];
  const warnings: string[] = [];
  for (const query of plan) {
    if (signal?.aborted) throw abortError(signal);
    if (now() - started >= budgetMs) break;
    const at = now();
    try {
      await runBounded(
        () => db.execute({ sql: query.sql, args: query.args }),
        queryTimeoutMs,
        signal,
      );
      const seconds = (now() - at) / 1000;
      ran.push({ label: query.label, ok: true, seconds });
      log(`warmed "${query.label}" (${seconds.toFixed(1)} s)`);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      const seconds = (now() - at) / 1000;
      const warning = `WARNING: warm-up "${query.label}" failed after ${seconds.toFixed(1)} s: ${errorMessage(error)}`;
      ran.push({ label: query.label, ok: false, seconds, warning });
      warnings.push(warning);
      log(warning);
    }
  }
  const skipped = plan.length - ran.length;
  if (skipped > 0) {
    const warning = `WARNING: warm-up stopped after ${ran.length} of ${plan.length} queries: budget ${(budgetMs / 1000).toFixed(0)} s spent`;
    warnings.push(warning);
    log(warning);
  }
  const seconds = (now() - started) / 1000;
  const summary = summaryLine(ran.length, seconds, skipped);
  log(summary);
  return { queries: ran, skipped, seconds, summary, warnings };
}

function summaryLine(ran: number, seconds: number, skipped: number): string {
  const queries = ran === 1 ? "1 query" : `${ran} queries`;
  const line = `warm-up: ${queries} in ${seconds.toFixed(1)} s`;
  return skipped === 0 ? line : `${line}, ${skipped} not started`;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

class QueryTimeout extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms} ms`);
    this.name = "QueryTimeout";
  }
}

/**
 * Waits for `run`, the per-query time, or `signal`, whichever is first.
 * A timed-out `run` keeps going in the driver; this function does not.
 */
async function runBounded(
  run: () => Promise<unknown>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) throw abortError(signal);
  let onAbort: (() => void) | undefined;
  const aborted =
    signal === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
          onAbort = () => reject(abortError(signal));
          signal.addEventListener("abort", onAbort);
        });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QueryTimeout(ms)), ms);
  });
  const settled = run().then(
    () => "ok" as const,
    (error: unknown) => error,
  );
  try {
    const result = await Promise.race(
      aborted === undefined
        ? [settled, timedOut]
        : [settled, timedOut, aborted],
    );
    if (signal?.aborted) throw abortError(signal);
    if (result !== "ok") throw result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
