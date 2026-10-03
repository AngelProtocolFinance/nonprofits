import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { COLUMNS, type SwappedTable } from "@nonprofits/db";
import {
  type IndexedFiling,
  type IndexTally,
  indexedFilings,
  latestPerEin,
} from "./efile-index.ts";
import { type ParsedReturn, parseReturn } from "./efile-xml.ts";
import {
  batches,
  download,
  downloadIfPresent,
  IMPORT_RUNS,
  type ImportFile,
  insertRun,
  literal,
  MAX_STATEMENT_BYTES,
  ORGS,
  run,
  setRowCount,
  tuple,
  writeLoad,
} from "./load.ts";
import { applyLoad, type D1Target } from "./wrangler.ts";
import { zipEntries } from "./zip.ts";

export const EFILE_BASE_URL = "https://apps.irs.gov/pub/epostcard/990/xml/";

/** The release years the import reads: this one and the two before it. */
export function releaseYears(now: Date): number[] {
  const year = now.getUTCFullYear();
  return [year, year - 1, year - 2];
}

/** Shares of the 990s parsed in a run that state a mission, and a total revenue. */
export interface EfileYield {
  mission: number;
  revenue: number;
}

/** 90% of the yields of the 21,404 Form 990s in 2026_TEOS_XML_03A: 99.1% state a mission, 100.0% a total revenue. */
export const EFILE_MIN_YIELD: EfileYield = { mission: 0.89, revenue: 0.9 };

export interface EfileImportOptions {
  /** Holds `{year}/index_{year}.csv` and `{year}/{batch}.zip`. */
  baseUrl: string;
  years: readonly number[];
  /**
   * Index XML_BATCH_IDs whose filings alone are loaded, leaving every other
   * stored filing as it is; omitted, every batch is loaded and filings this
   * run didn't write are deleted.
   */
  batches?: readonly string[];
  /** A run whose 990s fall below either share aborts before anything is applied. */
  minYield: EfileYield;
  /** Where batch zips are downloaded, one at a time, each deleted once read. */
  workDir: string;
  /** Where the generated SQL load file is written. */
  out: string;
  target: D1Target;
  /** Largest statement written, in bytes; defaults under D1's 100 KB limit. */
  maxStatementBytes?: number;
}

export interface EfileImportSummary {
  indexes: { url: string; releasedAt: string; rows: number }[];
  /** Index rows of return types not stored (990-T), by type. */
  skipped: Record<string, number>;
  zips: { url: string; releasedAt: string; filings: number }[];
  filings: number;
  /** Form 990s among `filings`, over which `yield` is measured. */
  forms990: number;
  yield: EfileYield;
}

type FilingColumn = (typeof COLUMNS.filings)[number];
type ProgramColumn = (typeof COLUMNS.programs)[number];
const FILINGS: SwappedTable = "filings";
const PROGRAMS: SwappedTable = "programs";

/** The `filings` columns a tuple holds, in order; `run_id` is the zip's run. */
const FILING_COLUMNS = [
  "ein",
  "object_id",
  "return_id",
  "form_type",
  "tax_period",
  "tax_year",
  "mission",
  "activity_summary",
  "website",
  "total_revenue",
  "total_expenses",
  "total_assets_eoy",
] as const satisfies readonly FilingColumn[];

const PROGRAM_COLUMNS = [
  "ein",
  "object_id",
  "rank",
  "description",
  "expense",
  "grants",
  "revenue",
] as const satisfies readonly ProgramColumn[];

/**
 * Reads the 990 e-file index of each release year, picks each EIN's latest
 * filing, and parses those filings out of the batch zips into one SQL load
 * file, applied to D1 in a single `wrangler d1 execute --file`. A drifted
 * index or return, a filing missing from its batch, a failed download or a
 * yield under the floor throws before the apply, leaving D1 untouched and no
 * load file behind.
 */
export async function importEfile(
  options: EfileImportOptions,
): Promise<EfileImportSummary> {
  let summary: EfileImportSummary | undefined;
  await writeLoad(
    options.out,
    (async function* () {
      summary = yield* efileSql(options);
    })(),
  );
  await applyLoad(options.out, options.target);
  return summary as EfileImportSummary;
}

/** The zips of one batch: `{prefix}A.zip`, then B, C… while filings remain unfound. */
interface BatchGroup {
  year: number;
  prefix: string;
  /** The latest filings the group holds, by object id. */
  wanted: Map<string, IndexedFiling>;
}

async function* efileSql(
  options: EfileImportOptions,
): AsyncGenerator<string, EfileImportSummary> {
  const { baseUrl, years } = options;
  const tally: IndexTally = { rows: 0, skipped: {} };
  const indexes: EfileImportSummary["indexes"] = [];
  const fetchedAt = new Date().toISOString();

  async function* listed(): AsyncGenerator<IndexedFiling> {
    for (const year of years) {
      const file: ImportFile = {
        source: "efile_index",
        label: "990 index",
        url: `${baseUrl}${year}/index_${year}.csv`,
      };
      const { body, releasedAt } = await download(file);
      const before = tally.rows;
      yield* indexedFilings(file, year, Readable.fromWeb(body), tally);
      indexes.push({ url: file.url, releasedAt, rows: tally.rows - before });
    }
  }
  const latest = await latestPerEin(listed());
  for (const index of indexes) {
    yield insertRun(
      { source: "efile_index", label: "990 index", url: index.url },
      index.releasedAt,
      fetchedAt,
    );
    yield setRowCount("efile_index", index.rows);
  }

  const zips: EfileImportSummary["zips"] = [];
  const counts = { filings: 0, forms990: 0, missions: 0, revenues: 0 };
  for (const group of batchGroups(latest, options.batches)) {
    for (const letter of BATCH_LETTERS) {
      if (group.wanted.size === 0) break;
      const file: ImportFile = {
        source: "efile_xml",
        label: "990 batch",
        url: `${baseUrl}${group.year}/${group.prefix}${letter}.zip`,
      };
      const path = join(options.workDir, `${group.prefix}${letter}.zip`);
      const releasedAt = await downloadTo(file, path);
      if (releasedAt === null) break;
      try {
        yield insertRun(file, releasedAt, fetchedAt);
        let filings = 0;
        for await (const batch of batches(
          parsedFilings(file, path, group.wanted),
          // sized together, the filing and program tuples bound both statements
          (p) => [p.filingTuple, ...p.programTuples].join(",\n"),
          upsertFilings([]),
          options.maxStatementBytes ?? MAX_STATEMENT_BYTES,
        )) {
          yield* filingsSql(batch);
          for (const { parsed } of batch) {
            filings++;
            if (parsed.formType !== "990") continue;
            counts.forms990++;
            if (parsed.mission !== null) counts.missions++;
            if (parsed.totalRevenue !== null) counts.revenues++;
          }
        }
        yield setRowCount("efile_xml", filings);
        zips.push({ url: file.url, releasedAt, filings });
        counts.filings += filings;
      } finally {
        await rm(path, { force: true });
      }
    }
    if (group.wanted.size > 0) {
      const missing = [...group.wanted.keys()];
      throw new Error(
        `990 import aborted: ${missing.length} latest filings listed in batch ${group.prefix}* are in none of its zips (${missing.slice(0, 5).join(", ")}); nothing was loaded`,
      );
    }
  }

  const share = (n: number) =>
    counts.forms990 === 0 ? 0 : n / counts.forms990;
  const observed = {
    mission: share(counts.missions),
    revenue: share(counts.revenues),
  };
  if (
    observed.mission < options.minYield.mission ||
    observed.revenue < options.minYield.revenue
  ) {
    throw new Error(
      `990 import aborted: of ${counts.forms990} Form 990s, ${percent(observed.mission)} state a mission and ${percent(observed.revenue)} a total revenue, below the floor of ${percent(options.minYield.mission)} and ${percent(options.minYield.revenue)}; nothing was loaded`,
    );
  }
  if (options.batches === undefined) {
    // every filing this run wrote cites a zip run newer than its index runs
    yield `DELETE FROM ${FILINGS} WHERE run_id < (SELECT max(${run("id")}) FROM ${IMPORT_RUNS} WHERE ${run("source")} = 'efile_index');\n`;
  }
  return {
    indexes,
    skipped: tally.skipped,
    zips,
    filings: counts.filings,
    forms990: counts.forms990,
    yield: observed,
  };
}

const BATCH_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A share as a percentage to one decimal, as the run reports yields. */
export function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

/**
 * The batches holding `latest`, narrowed to `only`. The index names a batch
 * `2026_TEOS_XML_05A` while the IRS splits it across `05A.zip` and `05B.zip`,
 * so a batch is looked up by its prefix, `2026_TEOS_XML_05`.
 */
function batchGroups(
  latest: Map<string, IndexedFiling>,
  only: readonly string[] | undefined,
): BatchGroup[] {
  const groups = new Map<string, BatchGroup>();
  for (const filing of latest.values()) {
    const prefix = filing.batch.slice(0, -1);
    const key = `${filing.year}/${prefix}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { year: filing.year, prefix, wanted: new Map() };
      groups.set(key, group);
    }
    group.wanted.set(filing.objectId, filing);
  }
  const all = [...groups.values()].sort((a, b) =>
    a.prefix.localeCompare(b.prefix),
  );
  if (only === undefined) return all;
  const prefixes = new Set(
    only.map((batch) => batch.toUpperCase().slice(0, -1)),
  );
  for (const prefix of prefixes) {
    if (!all.some((group) => group.prefix === prefix)) {
      throw new Error(
        `990 import aborted: no latest filing is listed in a batch ${prefix}*; nothing was loaded`,
      );
    }
  }
  return all.filter((group) => prefixes.has(group.prefix));
}

/** Downloads `file` to `path`, resolving with its Last-Modified, or null when the server has no such file. */
async function downloadTo(
  file: ImportFile,
  path: string,
): Promise<string | null> {
  const downloaded = await downloadIfPresent(file);
  if (downloaded === null) return null;
  await mkdir(dirname(path), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(downloaded.body), createWriteStream(path));
  } catch (error) {
    await rm(path, { force: true });
    throw new Error(`${file.label} download failed: ${file.url}: ${error}`, {
      cause: error,
    });
  }
  return downloaded.releasedAt;
}

/** A parsed filing with its index entry and its SQL tuples. */
interface Parsed {
  filing: IndexedFiling;
  parsed: ParsedReturn;
  filingTuple: string;
  programTuples: string[];
}

/** The wanted filings in the zip at `path`, each removed from `wanted` once parsed. */
async function* parsedFilings(
  file: ImportFile,
  path: string,
  wanted: Map<string, IndexedFiling>,
): AsyncGenerator<Parsed> {
  for await (const entry of zipEntries(path)) {
    const objectId = /^(?:.*\/)?(\d{18})_public\.xml$/.exec(entry.name)?.[1];
    const filing = objectId === undefined ? undefined : wanted.get(objectId);
    if (objectId === undefined || filing === undefined) continue;
    wanted.delete(objectId);
    let parsed: ParsedReturn;
    try {
      parsed = await parseReturn(entry.read());
    } catch (error) {
      throw new Error(
        `990 return ${objectId} in ${file.url} unreadable: ${error instanceof Error ? error.message : error}`,
        { cause: error },
      );
    }
    if (parsed.ein !== filing.ein || parsed.formType !== filing.formType) {
      throw new Error(
        `990 return ${objectId} in ${file.url} is a ${parsed.formType} for EIN ${parsed.ein}, but the index lists a ${filing.formType} for EIN ${filing.ein}`,
      );
    }
    yield {
      filing,
      parsed,
      filingTuple: filingTuple(filing, parsed),
      programTuples: programTuples(filing, parsed),
    };
  }
}

function filingTuple(filing: IndexedFiling, parsed: ParsedReturn): string {
  return tuple([
    filing.ein,
    filing.objectId,
    filing.returnId,
    filing.formType,
    filing.taxPeriod,
    parsed.taxYear,
    parsed.mission,
    parsed.activitySummary,
    parsed.website,
    parsed.totalRevenue,
    parsed.totalExpenses,
    parsed.totalAssetsEoy,
  ]);
}

function programTuples(filing: IndexedFiling, parsed: ParsedReturn): string[] {
  return parsed.programs.map((p, i) =>
    tuple([
      filing.ein,
      filing.objectId,
      i + 1,
      p.description,
      p.expense,
      p.grants,
      p.revenue,
    ]),
  );
}

/**
 * Replaces the filings of a batch's EINs: an EIN no source has listed gets a
 * nameless org row, and an EIN's old programs go before its filing is
 * replaced, since they reference its old object id.
 */
function* filingsSql(batch: readonly Parsed[]): Generator<string> {
  const eins = batch.map((p) => literal(p.filing.ein));
  yield `INSERT INTO ${ORGS} (ein) VALUES ${eins.map((ein) => `(${ein})`).join(", ")} ON CONFLICT (ein) DO NOTHING;\n`;
  yield `DELETE FROM ${PROGRAMS} WHERE ein IN (${eins.join(", ")});\n`;
  yield upsertFilings(batch.map((p) => p.filingTuple));
  const programs = batch.flatMap((p) => p.programTuples);
  if (programs.length > 0) {
    yield `INSERT INTO ${PROGRAMS} (${PROGRAM_COLUMNS.join(", ")}) VALUES ${programs.join(",\n")};\n`;
  }
}

/** Upserts filing tuples under the newest efile_xml run: the zip they came from. */
function upsertFilings(tuples: readonly string[]): string {
  const v = FILING_COLUMNS.map((_, i) => `v.column${i + 1}`);
  const updates = [...FILING_COLUMNS.slice(1), "run_id"].map(
    (column) => `${column} = excluded.${column}`,
  );
  return `INSERT INTO ${FILINGS} (${FILING_COLUMNS.join(", ")}, run_id)
SELECT ${v.join(", ")}, r.id
FROM (VALUES ${tuples.join(",\n")}) AS v, (SELECT max(${run("id")}) AS id FROM ${IMPORT_RUNS} WHERE ${run("source")} = 'efile_xml') AS r WHERE true
ON CONFLICT (ein) DO UPDATE SET ${updates.join(", ")};\n`;
}
