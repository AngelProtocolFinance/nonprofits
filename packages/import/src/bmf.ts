import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { COLUMNS, type ImportSource, type SwappedTable } from "@nonprofits/db";
import { CsvError, parse } from "csv-parse";
import { applyLoad, type D1Target } from "./wrangler.ts";

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

type OrgColumn = (typeof COLUMNS.orgs)[number];
type RunColumn = (typeof COLUMNS.import_runs)[number];
const org = (column: OrgColumn) => column;
const run = (column: RunColumn) => column;

const ORGS: SwappedTable = "orgs";
const IMPORT_RUNS: SwappedTable = "import_runs";
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

type BmfColumn = (typeof FIELDS)[number][0];

const BMF_FACTS = [
  "subsection",
  "ntee",
  "ruling_date",
  "deductibility_code",
  "filing_requirement_code",
] as const satisfies readonly OrgColumn[];

/** D1 rejects a statement over 100 KB. */
const MAX_STATEMENT_BYTES = 90_000;

export interface BmfImportOptions {
  urls: readonly string[];
  /** Fewer orgs than this across all files aborts before anything is applied. */
  minOrgs: number;
  /** Where the generated SQL load file is written. */
  out: string;
  target: D1Target;
  /** Largest upsert statement written, in bytes; defaults under D1's 100 KB limit. */
  maxStatementBytes?: number;
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
 * single `wrangler d1 execute --file`, so the orgs and their `import_runs`
 * rows commit together. A failed download, any layout drift or a short count
 * throws before the apply, leaving D1 untouched and no load file behind.
 */
export async function importBmf(
  options: BmfImportOptions,
): Promise<BmfImportSummary> {
  const summary = await writeLoad(options);
  await applyLoad(options.out, options.target);
  return summary;
}

async function writeLoad({
  urls,
  minOrgs,
  out,
  maxStatementBytes = MAX_STATEMENT_BYTES,
}: BmfImportOptions): Promise<BmfImportSummary> {
  await mkdir(dirname(out), { recursive: true });
  const files: BmfFileSummary[] = [];
  try {
    await pipeline(
      loadSql(urls, maxStatementBytes, files),
      createWriteStream(out),
    );
    const orgs = files.reduce((sum, f) => sum + f.orgs, 0);
    if (orgs < minOrgs) {
      throw new Error(
        `BMF import aborted: ${orgs} orgs is below the floor of ${minOrgs}; nothing was loaded`,
      );
    }
    return { orgs, files };
  } catch (error) {
    await rm(out, { force: true });
    throw error;
  }
}

/** The whole load, statement by statement; pushes each file's summary onto `files`. */
async function* loadSql(
  urls: readonly string[],
  maxStatementBytes: number,
  files: BmfFileSummary[],
): AsyncGenerator<string> {
  for (const url of urls) files.push(yield* bmfFileSql(url, maxStatementBytes));
  yield clearDroppedOrgs(urls.length);
}

async function* bmfFileSql(
  url: string,
  maxStatementBytes: number,
): AsyncGenerator<string, BmfFileSummary> {
  const { body, releasedAt } = await download(url);
  const fetchedAt = new Date().toISOString();
  const fixedBytes = Buffer.byteLength(upsertOrgs([]));
  let header: string[] | undefined;
  let orgs = 0;
  let batch: string[] = [];
  let batchBytes = 0;

  for await (const record of bmfRecords(url, body)) {
    if (header === undefined) {
      header = record;
      checkHeader(url, header);
      yield insertRun(url, releasedAt, fetchedAt);
      continue;
    }
    const tuple = toTuple(record);
    const tupleBytes = Buffer.byteLength(tuple);
    // +2 for the ",\n" between tuples
    if (
      batch.length > 0 &&
      fixedBytes + batchBytes + 2 + tupleBytes > maxStatementBytes
    ) {
      yield upsertOrgs(batch);
      batch = [];
      batchBytes = 0;
    }
    batchBytes += (batch.length > 0 ? 2 : 0) + tupleBytes;
    batch.push(tuple);
    orgs++;
  }
  if (header === undefined) throw new Error(`BMF file is empty: ${url}`);
  if (batch.length > 0) yield upsertOrgs(batch);
  yield setRowCount(orgs);
  return { url, releasedAt, orgs };
}

async function download(
  url: string,
): Promise<{ body: ReadableStream<Uint8Array>; releasedAt: string }> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw downloadFailed(url, error);
  }
  if (!response.ok || response.body === null) {
    throw new Error(`BMF download failed: ${url}: HTTP ${response.status}`);
  }
  const lastModified = response.headers.get("last-modified");
  if (lastModified === null) {
    throw new Error(`BMF download failed: ${url}: no Last-Modified header`);
  }
  return {
    body: response.body,
    releasedAt: new Date(lastModified).toISOString(),
  };
}

function downloadFailed(url: string, error: unknown): Error {
  const detail =
    error instanceof Error
      ? [error.message, error.cause instanceof Error && error.cause.message]
          .filter(Boolean)
          .join(": ")
      : String(error);
  return new Error(`BMF download failed: ${url}: ${detail}`, { cause: error });
}

/** The file's CSV records; a cut-off download or malformed CSV throws naming `url`. */
async function* bmfRecords(
  url: string,
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string[]> {
  const parser = parse({ bom: true });
  const parsing = pipeline(Readable.fromWeb(body), parser);
  // the same error reaches the loop below through the destroyed parser
  parsing.catch(() => {});
  try {
    for await (const record of parser) yield record as string[];
    await parsing;
  } catch (error) {
    throw error instanceof CsvError
      ? new Error(`BMF parse failed in ${url}: ${error.message}`, {
          cause: error,
        })
      : downloadFailed(url, error);
  } finally {
    // a consumer that stops early leaves the download open otherwise
    parser.destroy();
  }
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
  const values = FIELD_INDEXES.map(({ column, index }) => {
    const raw = record[index] ?? "";
    return column === "ruling_date" ? rulingDate(raw) : text(raw);
  });
  return `(${values.map(literal).join(",")})`;
}

const PLACEHOLDERS = new Set(["", "N/A", "NONE"]);

function text(raw: string): string | null {
  const value = raw.replaceAll("\0", "").trim();
  return PLACEHOLDERS.has(value.toUpperCase()) ? null : value;
}

/** RULING is YYYYMM; the BMF writes 000000 for no ruling. */
function rulingDate(raw: string): string | null {
  if (!/^\d{6}$/.test(raw)) return null;
  const year = raw.slice(0, 4);
  const month = raw.slice(4, 6);
  return year === "0000" || month === "00" ? null : `${year}-${month}`;
}

function literal(value: string | null): string {
  return value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
}

/** The newest bmf run: the one inserted just before the statement using it. */
const LATEST_BMF_RUN = `(SELECT max(${run("id")}) FROM ${IMPORT_RUNS} WHERE ${run("source")} = ${literal(SOURCE)})`;

function insertRun(url: string, releasedAt: string, fetchedAt: string): string {
  const columns = [
    run("source"),
    run("file_url"),
    run("released_at"),
    run("fetched_at"),
    run("row_count"),
  ];
  const values = [SOURCE, url, releasedAt, fetchedAt].map(literal);
  return `INSERT INTO ${IMPORT_RUNS} (${columns.join(", ")}) VALUES (${values.join(", ")}, 0);\n`;
}

function setRowCount(orgs: number): string {
  return `UPDATE ${IMPORT_RUNS} SET ${run("row_count")} = ${orgs} WHERE ${run("id")} = ${LATEST_BMF_RUN};\n`;
}

const ADDRESS = [
  "street",
  "city",
  "state",
  "zip",
] as const satisfies readonly BmfColumn[];

/**
 * Upserts a batch of tuples under the newest bmf run. A BMF row with no name,
 * or no address at all, keeps what another source wrote; the four address
 * columns move together.
 */
function upsertOrgs(tuples: readonly string[]): string {
  const columns: BmfColumn[] = FIELDS.map(([column]) => column);
  const v = (column: BmfColumn) => `v.column${columns.indexOf(column) + 1}`;
  const [nameRun, addressRun, bmfRun] = [
    org("name_run_id"),
    org("address_run_id"),
    org("bmf_run_id"),
  ];
  const select = [
    ...columns.map(v),
    `iif(${v("name")} IS NULL, NULL, r.id)`,
    `iif(coalesce(${ADDRESS.map(v).join(", ")}) IS NULL, NULL, r.id)`,
    "r.id",
  ];
  const keepUnlessBmf = (column: OrgColumn, runColumn: OrgColumn) =>
    `${column} = iif(excluded.${runColumn} IS NULL, ${ORGS}.${column}, excluded.${column})`;
  const updates = [
    keepUnlessBmf("name", nameRun),
    `${nameRun} = coalesce(excluded.${nameRun}, ${ORGS}.${nameRun})`,
    ...ADDRESS.map((column) => keepUnlessBmf(column, addressRun)),
    `${addressRun} = coalesce(excluded.${addressRun}, ${ORGS}.${addressRun})`,
    ...[bmfRun, ...BMF_FACTS].map((column) => `${column} = excluded.${column}`),
  ];
  return `INSERT INTO ${ORGS} (${[...columns, nameRun, addressRun, bmfRun].join(", ")})
SELECT ${select.join(", ")}
FROM (VALUES ${tuples.join(",\n")}) AS v, (SELECT ${LATEST_BMF_RUN} AS id) AS r WHERE true
ON CONFLICT (${org("ein")}) DO UPDATE SET ${updates.join(", ")};\n`;
}

/** An org missing from this import's files keeps its name and address but loses its BMF facts. */
function clearDroppedOrgs(runs: number): string {
  const bmfRun = org("bmf_run_id");
  const cleared = [bmfRun, ...BMF_FACTS].map((c) => `${c} = NULL`);
  return `UPDATE ${ORGS} SET ${cleared.join(", ")}
WHERE ${bmfRun} NOT IN (SELECT ${run("id")} FROM ${IMPORT_RUNS} WHERE ${run("source")} = ${literal(SOURCE)} ORDER BY ${run("id")} DESC LIMIT ${runs});\n`;
}
