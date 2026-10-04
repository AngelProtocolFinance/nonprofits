import { Readable } from "node:stream";
import type { ImportSource } from "@nonprofits/db";
import {
  batches,
  DOWNLOAD_RETRY,
  type DownloadRetry,
  download,
  IMPORT_RUNS,
  type ImportFile,
  insertRun,
  literal,
  MAX_STATEMENT_BYTES,
  ORGS,
  type OrgColumn,
  type OrgUpsert,
  org,
  records,
  run,
  setRowCount,
  text,
  tuple,
  upsertOrgs,
  writeLoad,
} from "./load.ts";
import { retrying } from "./retry.ts";
import type { D1Target } from "./wrangler.ts";

/** The EO BMF, split by IRS region. */
export const BMF_URLS = [1, 2, 3, 4].map(
  (n) => `https://www.irs.gov/pub/irs-soi/eo${n}.csv`,
);

/** ~90% of the 1,964,958 orgs across the September 2026 BMF. */
export const BMF_MIN_ORGS = 1_768_000;

/** The BMF's published layout; any drift aborts the import. */
export const BMF_HEADER = [
  "EIN",
  "NAME",
  "ICO",
  "STREET",
  "CITY",
  "STATE",
  "ZIP",
  "GROUP",
  "SUBSECTION",
  "AFFILIATION",
  "CLASSIFICATION",
  "RULING",
  "DEDUCTIBILITY",
  "FOUNDATION",
  "ACTIVITY",
  "ORGANIZATION",
  "STATUS",
  "TAX_PERIOD",
  "ASSET_CD",
  "INCOME_CD",
  "FILING_REQ_CD",
  "PF_FILING_REQ_CD",
  "ACCT_PD",
  "ASSET_AMT",
  "INCOME_AMT",
  "REVENUE_AMT",
  "NTEE_CD",
  "SORT_NAME",
] as const;

const SOURCE: ImportSource = "bmf";

/** The `orgs` columns a BMF row fills, in VALUES order, each from its BMF field. */
const FIELDS = [
  ["ein", "EIN"],
  ["name", "NAME"],
  ["street", "STREET"],
  ["city", "CITY"],
  ["state", "STATE"],
  ["zip", "ZIP"],
  ["subsection", "SUBSECTION"],
  ["ntee", "NTEE_CD"],
  ["ruling_date", "RULING"],
  ["deductibility_code", "DEDUCTIBILITY"],
  ["filing_requirement_code", "FILING_REQ_CD"],
] as const satisfies readonly (readonly [
  OrgColumn,
  (typeof BMF_HEADER)[number],
])[];

const BMF_FACTS = [
  "subsection",
  "ntee",
  "ruling_date",
  "deductibility_code",
  "filing_requirement_code",
] as const satisfies readonly OrgColumn[];

export interface BmfImportOptions {
  urls: readonly string[];
  /** Fewer orgs than this across all files aborts before anything is applied. */
  minOrgs: number;
  /** Where the generated SQL load file is written. */
  out: string;
  target: D1Target;
  /** Largest upsert statement written, in bytes; defaults under D1's 100 KB limit. */
  maxStatementBytes?: number;
  /** A file that failed transiently restarts the load from the first file; defaults to `DOWNLOAD_RETRY`. */
  retry?: DownloadRetry;
}

export interface BmfFileSummary {
  url: string;
  /** The file's Last-Modified, ISO-8601. */
  releasedAt: string;
  orgs: number;
}

export interface BmfImportSummary {
  orgs: number;
  files: BmfFileSummary[];
}

/**
 * Streams each BMF file into one SQL load file, then applies it to D1 in a
 * single `wrangler d1 execute --file`, so the orgs and their `import_runs` rows
 * commit together; the search index is left for the caller to rebuild. A
 * failed download, any layout drift or a short count throws before the apply,
 * leaving D1 untouched and no load file behind.
 */
export async function importBmf(
  options: BmfImportOptions,
): Promise<BmfImportSummary> {
  const summary = await writeBmfLoad(options);
  await options.target.ops.applyFile(options.target.binding, options.out);
  return summary;
}

async function writeBmfLoad({
  urls,
  minOrgs,
  out,
  target,
  maxStatementBytes = MAX_STATEMENT_BYTES,
  retry = DOWNLOAD_RETRY,
}: BmfImportOptions): Promise<BmfImportSummary> {
  const files: BmfFileSummary[] = [];
  // each file streams into the load as it arrives, so a retry starts the load over
  await retrying("BMF load", retry, () => {
    files.length = 0;
    return writeLoad(
      out,
      target.buildId,
      loadSql(urls, minOrgs, maxStatementBytes, retry.stallMs, files),
    );
  });
  return { orgs: totalOrgs(files), files };
}

const totalOrgs = (files: readonly BmfFileSummary[]) =>
  files.reduce((sum, f) => sum + f.orgs, 0);

/** The whole load, statement by statement; pushes each file's summary onto `files`. */
async function* loadSql(
  urls: readonly string[],
  minOrgs: number,
  maxStatementBytes: number,
  stallMs: number,
  files: BmfFileSummary[],
): AsyncGenerator<string> {
  for (const url of urls) {
    files.push(
      yield* bmfFileSql(
        { source: SOURCE, label: "BMF", url },
        maxStatementBytes,
        stallMs,
      ),
    );
  }
  const orgs = totalOrgs(files);
  if (orgs < minOrgs) {
    throw new Error(
      `BMF import aborted: ${orgs} orgs is below the floor of ${minOrgs}; nothing was loaded`,
    );
  }
  yield clearDroppedOrgs(urls.length);
}

async function* bmfFileSql(
  file: ImportFile,
  maxStatementBytes: number,
  stallMs: number,
): AsyncGenerator<string, BmfFileSummary> {
  const { body, releasedAt } = await download(file, stallMs);
  yield insertRun(file, releasedAt, new Date().toISOString());
  let orgs = 0;
  async function* tuples(): AsyncGenerator<string> {
    let header: string[] | undefined;
    for await (const record of records(file, Readable.fromWeb(body), {
      bom: true,
    })) {
      if (header === undefined) {
        header = record;
        checkHeader(file.url, header);
        continue;
      }
      orgs++;
      yield toTuple(record);
    }
    if (header === undefined) throw new Error(`BMF file is empty: ${file.url}`);
  }
  for await (const batch of batches(
    tuples(),
    (tuple) => tuple,
    upsertOrgs(UPSERT, []),
    maxStatementBytes,
  )) {
    yield upsertOrgs(UPSERT, batch);
  }
  yield setRowCount(SOURCE, orgs);
  return { url: file.url, releasedAt, orgs };
}

function checkHeader(url: string, header: readonly string[]): void {
  const expected: readonly string[] = BMF_HEADER;
  const missing = expected.filter((c) => !header.includes(c));
  const unexpected = header.filter((c) => !expected.includes(c));
  const width = Math.max(expected.length, header.length);
  const moved = Array.from({ length: width }).findIndex(
    (_, i) => header[i] !== expected[i],
  );
  if (moved === -1) return;
  const drift = [
    missing.length > 0 && `missing ${missing.join(", ")}`,
    unexpected.length > 0 && `unexpected ${unexpected.join(", ")}`,
    missing.length === 0 &&
      unexpected.length === 0 &&
      `column ${moved + 1} is ${header[moved] ?? "absent"}, expected ${expected[moved] ?? "nothing"}`,
  ].filter(Boolean);
  throw new Error(`BMF layout changed in ${url}: ${drift.join("; ")}`);
}

const FIELD_INDEXES = FIELDS.map(([column, field]) => ({
  column,
  index: BMF_HEADER.indexOf(field),
}));

function toTuple(record: readonly string[]): string {
  return tuple(
    FIELD_INDEXES.map(({ column, index }) => {
      const raw = record[index] ?? "";
      return column === "ruling_date" ? rulingDate(raw) : text(raw);
    }),
  );
}

/** RULING is YYYYMM; the BMF writes 000000 for no ruling. */
function rulingDate(raw: string): string | null {
  if (!/^\d{6}$/.test(raw)) return null;
  const year = raw.slice(0, 4);
  const month = raw.slice(4, 6);
  return year === "0000" || month === "00" ? null : `${year}-${month}`;
}

const UPSERT: OrgUpsert = {
  source: SOURCE,
  columns: FIELDS.map(([column]) => column),
  derived: [["bmf_run_id", "r.id"]],
  facts: [org("bmf_run_id"), ...BMF_FACTS].map(
    (column) => `${column} = excluded.${column}`,
  ),
};

/** An org missing from this import's files keeps its name and address but loses its BMF facts. */
function clearDroppedOrgs(runs: number): string {
  const bmfRun = org("bmf_run_id");
  const cleared = [bmfRun, ...BMF_FACTS].map((c) => `${c} = NULL`);
  return `UPDATE ${ORGS} SET ${cleared.join(", ")}
WHERE ${bmfRun} NOT IN (SELECT ${run("id")} FROM ${IMPORT_RUNS} WHERE ${run("source")} = ${literal(SOURCE)} ORDER BY ${run("id")} DESC LIMIT ${runs});\n`;
}
