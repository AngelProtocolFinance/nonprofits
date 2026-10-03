import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { COLUMNS, type ImportSource, type SwappedTable } from "@nonprofits/db";
import { CsvError, type Options as CsvOptions, parse } from "csv-parse";

export type OrgColumn = (typeof COLUMNS.orgs)[number];
type RunColumn = (typeof COLUMNS.import_runs)[number];
export const org = (column: OrgColumn) => column;
export const run = (column: RunColumn) => column;

export const ORGS: SwappedTable = "orgs";
export const IMPORT_RUNS: SwappedTable = "import_runs";

/** D1 rejects a statement over 100 KB. */
export const MAX_STATEMENT_BYTES = 90_000;

/** An IRS file being imported: its source, and what error messages call it. */
export interface ImportFile {
  source: ImportSource;
  label: string;
  url: string;
}

/**
 * Writes `sql` to `out` statement by statement. Anything `sql` throws removes
 * the partial file and rethrows, so a failed import leaves nothing to apply.
 */
export async function writeLoad(
  out: string,
  sql: AsyncIterable<string>,
): Promise<void> {
  await mkdir(dirname(out), { recursive: true });
  try {
    await pipeline(sql, createWriteStream(out));
  } catch (error) {
    await rm(out, { force: true });
    throw error;
  }
}

/** Fetches `file`; its Last-Modified becomes the run's `released_at`. */
export async function download(
  file: ImportFile,
): Promise<{ body: ReadableStream<Uint8Array>; releasedAt: string }> {
  let response: Response;
  try {
    response = await fetch(file.url);
  } catch (error) {
    throw downloadFailed(file, error);
  }
  if (!response.ok || response.body === null) {
    throw new Error(
      `${file.label} download failed: ${file.url}: HTTP ${response.status}`,
    );
  }
  const lastModified = response.headers.get("last-modified");
  if (lastModified === null) {
    throw new Error(
      `${file.label} download failed: ${file.url}: no Last-Modified header`,
    );
  }
  return {
    body: response.body,
    releasedAt: new Date(lastModified).toISOString(),
  };
}

function downloadFailed(file: ImportFile, error: unknown): Error {
  const detail =
    error instanceof Error
      ? [error.message, error.cause instanceof Error && error.cause.message]
          .filter(Boolean)
          .join(": ")
      : String(error);
  return new Error(`${file.label} download failed: ${file.url}: ${detail}`, {
    cause: error,
  });
}

/**
 * The delimited records in `bytes`; a cut-off download or malformed text
 * throws naming the file.
 */
export async function* records(
  file: ImportFile,
  bytes: Readable,
  options: CsvOptions,
): AsyncGenerator<string[]> {
  const parser = parse(options);
  const parsing = pipeline(bytes, parser);
  // the same error reaches the loop below through the destroyed parser
  parsing.catch(() => {});
  try {
    for await (const record of parser) yield record as string[];
    await parsing;
  } catch (error) {
    throw error instanceof CsvError
      ? new Error(
          `${file.label} parse failed in ${file.url}: ${error.message}`,
          {
            cause: error,
          },
        )
      : downloadFailed(file, error);
  } finally {
    // a consumer that stops early leaves the download open otherwise
    parser.destroy();
  }
}

/**
 * Groups `items` so that one statement made of `emptyStatement` plus a group's
 * tuples (`tupleOf` each item) stays within `maxStatementBytes`.
 */
export async function* batches<T>(
  items: AsyncIterable<T>,
  tupleOf: (item: T) => string,
  emptyStatement: string,
  maxStatementBytes: number,
): AsyncGenerator<T[]> {
  const fixedBytes = Buffer.byteLength(emptyStatement);
  let batch: T[] = [];
  let batchBytes = 0;
  for await (const item of items) {
    const tupleBytes = Buffer.byteLength(tupleOf(item));
    // +2 for the ",\n" between tuples
    if (
      batch.length > 0 &&
      fixedBytes + batchBytes + 2 + tupleBytes > maxStatementBytes
    ) {
      yield batch;
      batch = [];
      batchBytes = 0;
    }
    batchBytes += (batch.length > 0 ? 2 : 0) + tupleBytes;
    batch.push(item);
  }
  if (batch.length > 0) yield batch;
}

const PLACEHOLDERS = new Set(["", "N/A", "NONE"]);

/** Trimmed text, null for an IRS placeholder. */
export function text(raw: string): string | null {
  const value = raw.replaceAll("\0", "").trim();
  return PLACEHOLDERS.has(value.toUpperCase()) ? null : value;
}

export function literal(value: string | null): string {
  return value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
}

export function tuple(values: readonly (string | null)[]): string {
  return `(${values.map(literal).join(",")})`;
}

/** The newest run of `source`: the one inserted just before the statement using it. */
function latestRun(source: ImportSource): string {
  return `(SELECT max(${run("id")}) FROM ${IMPORT_RUNS} WHERE ${run("source")} = ${literal(source)})`;
}

/** Opens a run for `file`; its `row_count` is set once the file is read. */
export function insertRun(
  file: ImportFile,
  releasedAt: string,
  fetchedAt: string,
): string {
  const columns = [
    run("source"),
    run("file_url"),
    run("released_at"),
    run("fetched_at"),
    run("row_count"),
  ];
  const values = [file.source, file.url, releasedAt, fetchedAt].map(literal);
  return `INSERT INTO ${IMPORT_RUNS} (${columns.join(", ")}) VALUES (${values.join(", ")}, 0);\n`;
}

export function setRowCount(source: ImportSource, rows: number): string {
  return `UPDATE ${IMPORT_RUNS} SET ${run("row_count")} = ${rows} WHERE ${run("id")} = ${latestRun(source)};\n`;
}

/** Sources that write an org's name and address, highest precedence first. */
const NAME_AND_ADDRESS_PRECEDENCE = [
  "bmf",
  "pub78",
  "revocation",
] as const satisfies readonly ImportSource[];
type NameAndAddressSource = (typeof NAME_AND_ADDRESS_PRECEDENCE)[number];

function writesNameAndAddress(
  source: ImportSource,
): source is NameAndAddressSource {
  return (NAME_AND_ADDRESS_PRECEDENCE as readonly ImportSource[]).includes(
    source,
  );
}

const ADDRESS = [
  "street",
  "city",
  "state",
  "zip",
] as const satisfies readonly OrgColumn[];

/** How one source's tuples land in `orgs`. */
export interface OrgUpsert {
  source: ImportSource;
  /** The `orgs` columns each tuple holds, in order. */
  columns: readonly OrgColumn[];
  /** Further columns set on insert, each from a SQL expression; `r.id` is this run. */
  derived?: readonly (readonly [OrgColumn, string])[];
  /** SET clauses for the facts this source owns, applied when the EIN exists. */
  facts: readonly string[];
}

/**
 * Upserts a batch of tuples under the newest run of `upsert.source`. A source
 * that carries a name or an address writes it unless its row has none or a
 * source ahead of it in the precedence wrote what is stored; the four address
 * columns move together.
 */
export function upsertOrgs(
  upsert: OrgUpsert,
  tuples: readonly string[],
): string {
  const { source, columns } = upsert;
  const v = (column: OrgColumn) => `v.column${columns.indexOf(column) + 1}`;
  const owned: [OrgColumn, string][] = [];
  const updates: string[] = [];
  if (writesNameAndAddress(source) && columns.includes("name")) {
    owned.push(["name_run_id", `iif(${v("name")} IS NULL, NULL, r.id)`]);
    updates.push(...takeUnlessOutranked(source, "name_run_id", ["name"]));
  }
  const address = ADDRESS.filter((c) => columns.includes(c));
  if (writesNameAndAddress(source) && address.length > 0) {
    owned.push([
      "address_run_id",
      `iif(coalesce(${address.map(v).join(", ")}) IS NULL, NULL, r.id)`,
    ]);
    updates.push(...takeUnlessOutranked(source, "address_run_id", ADDRESS));
  }
  const inserted = [...owned, ...(upsert.derived ?? [])];
  return `INSERT INTO ${ORGS} (${[...columns, ...inserted.map(([c]) => c)].join(", ")})
SELECT ${[...columns.map(v), ...inserted.map(([, e]) => e)].join(", ")}
FROM (VALUES ${tuples.join(",\n")}) AS v, (SELECT ${latestRun(source)} AS id) AS r WHERE true
ON CONFLICT (${org("ein")}) DO UPDATE SET ${[...updates, ...upsert.facts].join(", ")};\n`;
}

/**
 * SET clauses taking `columns` and their run from the incoming row, unless it
 * has none or the stored value came from a source ahead of `source`.
 */
function takeUnlessOutranked(
  source: NameAndAddressSource,
  runColumn: OrgColumn,
  columns: readonly OrgColumn[],
): string[] {
  const ahead = NAME_AND_ADDRESS_PRECEDENCE.slice(
    0,
    NAME_AND_ADDRESS_PRECEDENCE.indexOf(source),
  );
  const stored = `${ORGS}.${runColumn}`;
  const take = [
    `excluded.${runColumn} IS NOT NULL`,
    ...(ahead.length === 0
      ? []
      : [
          `(${stored} IS NULL OR (SELECT ${run("source")} FROM ${IMPORT_RUNS} WHERE ${run("id")} = ${stored}) NOT IN (${ahead.map(literal).join(", ")}))`,
        ]),
  ].join(" AND ");
  return [...columns, runColumn].map(
    (column) =>
      `${column} = iif(${take}, excluded.${column}, ${ORGS}.${column})`,
  );
}
