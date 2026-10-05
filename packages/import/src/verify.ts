/** A new build's row counts may differ from the served one's by this share and still pass. */
const COUNT_TOLERANCE = 0.1;
/** What verify counts, each the rows `count(*)` reads: every table's, and the orgs each list fact landed on. */
const COUNTED = {
  orgs: "orgs",
  filings: "filings",
  programs: "programs",
  in_pub78: "orgs WHERE in_pub78 = 1",
  revocation_date: "orgs WHERE revocation_date IS NOT NULL",
  files_990n: "orgs WHERE files_990n = 1",
  bmf_run_id: "orgs WHERE bmf_run_id IS NOT NULL",
} as const;
type Counted = keyof typeof COUNTED;

/** Each of verify's counts for one data database. */
export type Counts = Record<Counted, number>;

/** The fewest of each count a build may hold: a first build's only count check, as it has no served counts to compare with. */
export type TableFloors = Counts;

export const TABLE_FLOORS: TableFloors = {
  // 90% of the 3,275,963 orgs of the 2026-10-03 local build (Sep 2026 BMF and lists)
  orgs: 2_948_000,
  // 90% of the 760,592 latest filings a full run selects from the 2024–2026 indexes of 2026-10-03
  filings: 684_000,
  // 80% of ~939,500: 1.50 programs per 990 and 990-EZ filing in batch 2026_TEOS_XML_03A
  // (57,624 for 38,404) times the 626,151 a full run selects; an extrapolation, hence the wider margin
  programs: 750_000,
  // 90% of the 2026-10-03 local build's 1,419,989 orgs in Pub 78 (Sep 2026 list)
  in_pub78: 1_277_000,
  // 90% of its 1,227,606 orgs with a revocation date (Sep 2026 list)
  revocation_date: 1_104_000,
  // 90% of its 1,546,723 990-N filers (Sep 2026 e-Postcard list)
  files_990n: 1_392_000,
  // 90% of its 1,964,958 orgs from the Sep 2026 BMF
  bmf_run_id: 1_768_000,
};

/** The org every build must hold with a mission. */
export const RED_CROSS = "530196605";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  seconds: number;
}

/** Runs one query against a data database; resolves with its rows. */
export type ReadData = <T>(sql: string) => Promise<T[]>;

/** Runs a named check, adding it to `checks` and logging it once it ends. */
export type RunCheck = (
  name: string,
  run: () => Promise<{ ok: boolean; detail: string }>,
) => Promise<void>;

/** A `RunCheck` that adds each check to `checks` and logs a line for it. */
export function checker(
  checks: Check[],
  log: (line: string) => void,
): RunCheck {
  return async (name, run) => {
    const started = performance.now();
    const result = await run();
    const seconds = (performance.now() - started) / 1000;
    checks.push({ name, ...result, seconds });
    log(
      `check ${name}: ${result.ok ? "ok" : "FAILED"}, ${result.detail} (${seconds.toFixed(1)} s)`,
    );
  };
}

async function count(read: ReadData, rows: string): Promise<number> {
  const [row] = await read<{ n: number }>(`SELECT count(*) AS n FROM ${rows}`);
  if (row === undefined) throw new Error("the count returned no row");
  return row.n;
}

/** Every one of verify's counts in the data database `read` queries: what a later build's `served` is. */
export async function readCounts(read: ReadData): Promise<Counts> {
  const counts = {} as Counts;
  for (const [name, rows] of Object.entries(COUNTED) as [Counted, string][]) {
    counts[name] = await count(read, rows);
  }
  return counts;
}

export interface VerifyDataOptions {
  floors: TableFloors;
  /** The served build's counts; each count must then be within 10% of its own. Omitted for a first build. */
  served?: Counts | undefined;
  /** Adds a check that always fails, after every real one. */
  forceVerifyFailure: boolean;
  check: RunCheck;
  log: (line: string) => void;
}

/**
 * The checks a build's data must pass before it is served, one query each so
 * each one's time shows in the log: every count at its floor (and within 10%
 * of `served`'s), the Red Cross with its mission and in Pub 78, a search index
 * row for each named org, and no row without an EIN. Resolves with the counts.
 */
export async function verifyData(
  read: ReadData,
  { floors, served, forceVerifyFailure, check, log }: VerifyDataOptions,
): Promise<Counts> {
  const counts = {} as Counts;
  for (const [name, rows] of Object.entries(COUNTED) as [Counted, string][]) {
    await check(`${name} floor`, async () => {
      counts[name] = await count(read, rows);
      return {
        ok: counts[name] >= floors[name],
        detail: `${name}: ${counts[name]}, floor ${floors[name]}`,
      };
    });
    if (served === undefined) continue;
    await check(`${name} vs served`, async () => ({
      ok:
        Math.abs(counts[name] - served[name]) <= COUNT_TOLERANCE * served[name],
      detail: `${name}: ${counts[name]}, served ${served[name]}`,
    }));
  }
  if (served === undefined) log("no served build to compare counts with");
  await check("red cross", async () => {
    const [row] = await read<{ mission: string | null }>(
      `SELECT f.mission FROM orgs o JOIN filings f ON f.ein = o.ein WHERE o.ein = '${RED_CROSS}'`,
    );
    const ok = Boolean(row?.mission?.trim());
    return {
      ok,
      detail: ok
        ? `${RED_CROSS} has its mission`
        : `${RED_CROSS} has no filing with a mission`,
    };
  });
  await check("red cross deductible", async () => {
    const [row] = await read<{ in_pub78: number }>(
      `SELECT in_pub78 FROM orgs WHERE ein = '${RED_CROSS}'`,
    );
    const ok = row?.in_pub78 === 1;
    return {
      ok,
      detail: ok
        ? `${RED_CROSS} is in Pub 78`
        : `${RED_CROSS} is not in Pub 78`,
    };
  });
  await check("search index", async () => {
    const [row] = await read<{ index_rows: number; named_orgs: number }>(
      "SELECT (SELECT count(*) FROM orgs_fts) AS index_rows, (SELECT count(*) FROM orgs WHERE name IS NOT NULL) AS named_orgs",
    );
    return {
      ok: row !== undefined && row.index_rows === row.named_orgs,
      detail: `${row?.index_rows} index rows, ${row?.named_orgs} named orgs`,
    };
  });
  await check("null eins", async () => {
    const [row] = await read<{ n: number }>(
      "SELECT (SELECT count(*) FROM orgs WHERE ein IS NULL) + (SELECT count(*) FROM filings WHERE ein IS NULL) + (SELECT count(*) FROM programs WHERE ein IS NULL) AS n",
    );
    const n = row?.n;
    return { ok: n === 0, detail: `${n} rows without an EIN` };
  });
  if (forceVerifyFailure) {
    await check("forced failure", async () => ({
      ok: false,
      detail: "--force-verify-failure was given",
    }));
  }
  return counts;
}

/** The checks among `checks` that failed, as one error; null when all passed. */
export function verifyFailure(
  what: string,
  checks: readonly Check[],
): Error | null {
  const failed = checks.filter((check) => !check.ok);
  return failed.length === 0
    ? null
    : new Error(
        `verify failed for ${what}: ${failed.map((c) => `${c.name} (${c.detail})`).join("; ")}`,
      );
}
