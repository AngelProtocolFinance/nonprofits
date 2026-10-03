import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
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
 * rows commit together. Any layout drift or a short count throws before the
 * apply, leaving D1 untouched.
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
}: BmfImportOptions): Promise<BmfImportSummary> {
  await mkdir(dirname(out), { recursive: true });
  const sql = createWriteStream(out);
  try {
    const files: BmfFileSummary[] = [];
    for (const url of urls) files.push(await writeFile(url, sql));
    await write(sql, clearDroppedOrgs(urls.length));
    sql.end();
    await finished(sql);
    const orgs = files.reduce((sum, f) => sum + f.orgs, 0);
    if (orgs < minOrgs) {
      throw new Error(
        `BMF import aborted: ${orgs} orgs is below the floor of ${minOrgs}; nothing was loaded`,
      );
    }
    return { orgs, files };
  } catch (error) {
    sql.destroy();
    await rm(out, { force: true });
    throw error;
  }
}

async function writeFile(
  url: string,
  sql: WriteStream,
): Promise<BmfFileSummary> {
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`BMF download failed: ${url} answered ${response.status}`);
  }
  const lastModified = response.headers.get("last-modified");
  if (lastModified === null) {
    throw new Error(`BMF download has no Last-Modified: ${url}`);
  }
  const releasedAt = new Date(lastModified).toISOString();
  const fetchedAt = new Date().toISOString();

  const download = Readable.fromWeb(response.body);
  const records = download.pipe(parse({ bom: true }));
  let header: string[] | undefined;
  let orgs = 0;
  let batch: string[] = [];
  let batchBytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    await write(sql, upsertOrgs(batch));
    batch = [];
    batchBytes = 0;
  };

  try {
    for await (const record of records as AsyncIterable<string[]>) {
      if (header === undefined) {
        header = record;
        checkHeader(url, header);
        await write(sql, insertRun(url, releasedAt, fetchedAt));
        continue;
      }
      const tuple = toTuple(record);
      batch.push(tuple);
      batchBytes += Buffer.byteLength(tuple) + 1;
      orgs++;
      if (batchBytes > MAX_STATEMENT_BYTES) await flush();
    }
  } catch (error) {
    if (error instanceof CsvError) {
      throw new Error(`BMF parse failed in ${url}: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    // pipe() leaves the download open when the parser stops early
    download.destroy();
  }
  if (header === undefined) throw new Error(`BMF file is empty: ${url}`);
  await flush();
  await write(sql, setRowCount(orgs));
  return { url, releasedAt, orgs };
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

/** Resolves once the stream can take more, so a slow disk can't buffer a whole file. */
async function write(stream: WriteStream, chunk: string): Promise<void> {
  if (!stream.write(chunk)) await once(stream, "drain");
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
  const value = raw.trim();
  return PLACEHOLDERS.has(value.toUpperCase()) ? null : value;
}

/** RULING is YYYYMM; the BMF writes 000000 for no ruling. */
function rulingDate(raw: string): string | null {
  const year = raw.slice(0, 4);
  const month = raw.slice(4, 6);
  return year === "0000" || month === "00" ? null : `${year}-${month}`;
}

function literal(value: string | null): string {
  return value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
}

function insertRun(url: string, releasedAt: string, fetchedAt: string): string {
  return `INSERT INTO ${IMPORT_RUNS} (source, file_url, released_at, fetched_at, row_count) VALUES (${[SOURCE, url, releasedAt, fetchedAt].map(literal).join(", ")}, 0);\n`;
}

function setRowCount(orgs: number): string {
  return `UPDATE ${IMPORT_RUNS} SET row_count = ${orgs} WHERE id = (SELECT max(id) FROM ${IMPORT_RUNS});\n`;
}

/** Upserts a batch of tuples, each pointing at the run inserted just before it. */
function upsertOrgs(tuples: readonly string[]): string {
  const columns: BmfColumn[] = FIELDS.map(([column]) => column);
  const v = (column: BmfColumn) => `v.column${columns.indexOf(column) + 1}`;
  const address = (["street", "city", "state", "zip"] as const)
    .map(v)
    .join(", ");
  const insert = [...columns, "name_run_id", "address_run_id", "bmf_run_id"];
  const select = [
    ...columns.map(v),
    `iif(${v("name")} IS NULL, NULL, r.id)`,
    `iif(coalesce(${address}) IS NULL, NULL, r.id)`,
    "r.id",
  ];
  const updates = insert
    .filter((c) => c !== "ein")
    .map((c) => `${c} = excluded.${c}`);
  return `INSERT INTO ${ORGS} (${insert.join(", ")})
SELECT ${select.join(", ")}
FROM (VALUES ${tuples.join(",\n")}) AS v, (SELECT max(id) AS id FROM ${IMPORT_RUNS}) AS r WHERE true
ON CONFLICT (ein) DO UPDATE SET ${updates.join(", ")};\n`;
}

/** An org missing from this import's files keeps its name and address but loses its BMF facts. */
function clearDroppedOrgs(runs: number): string {
  const cleared = ["bmf_run_id", ...BMF_FACTS].map((c) => `${c} = NULL`);
  return `UPDATE ${ORGS} SET ${cleared.join(", ")}
WHERE bmf_run_id NOT IN (SELECT id FROM ${IMPORT_RUNS} ORDER BY id DESC LIMIT ${runs});\n`;
}
