import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { COLUMNS, type DataTable } from "@nonprofits/db";
import {
  type FormType,
  type IndexedFiling,
  type IndexTally,
  indexedFilings,
  latestPerEin,
} from "./efile-index.ts";
import {
  type ParsedReturn,
  parseReturn,
  RejectedReturn,
  type RejectReason,
} from "./efile-xml.ts";
import {
  batches,
  download,
  downloadIfPresent,
  type ImportFile,
  insertRun,
  latestRun,
  literal,
  MAX_STATEMENT_BYTES,
  ORGS,
  org,
  setRowCount,
  tuple,
  writeLoad,
} from "./load.ts";
import type { D1Target } from "./wrangler.ts";
import { zipEntries } from "./zip.ts";

export const EFILE_BASE_URL = "https://apps.irs.gov/pub/epostcard/990/xml/";

/** Release years read: the latest whose index is published, and the two before it. */
const RELEASE_YEARS = 3;

/** What a return states to count toward each yield a run measures. */
const YIELDS = {
  mission: {
    states: "a mission",
    in: (p: ParsedReturn) => p.mission !== null,
  },
  revenue: {
    states: "a total revenue",
    in: (p: ParsedReturn) => p.totalRevenue !== null,
  },
  finances: {
    states: "total revenue, expenses and assets",
    in: (p: ParsedReturn) =>
      p.totalRevenue !== null &&
      p.totalExpenses !== null &&
      p.totalAssetsEoy !== null,
  },
};
type YieldName = keyof typeof YIELDS;

/** The yields each form is held to, in the order a run reports them. */
const FORM_YIELDS = {
  "990": ["mission", "revenue"],
  "990-EZ": ["mission", "finances"],
  "990-PF": ["finances"],
} as const satisfies Record<FormType, readonly YieldName[]>;

/** Shares of a run's returns of each form, rejected ones included, that state each yield the form is held to. */
export type FormYields = {
  [F in FormType]: Record<(typeof FORM_YIELDS)[F][number], number>;
};

/** What a run must meet to load; any miss aborts it before anything is applied. */
export interface EfileFloors extends FormYields {
  /** A returnVersion with at least this many returns of a form in the run is held to that form's floors. */
  versionFrom: number;
  /** The largest share of the run's selected filings that may be rejected. */
  rejects: number;
}

export const EFILE_FLOORS: EfileFloors = {
  // 90% of the yields of the 21,404 Form 990s in 2026_TEOS_XML_03A: 98.0% and 100.0%
  "990": { mission: 0.88, revenue: 0.9 },
  // 90% of the lowest yield among the latest 990-EZs of 2024–2026 (245,988), run-wide or in a returnVersion
  // with 200+ of them: mission 95.9% (2025v4.2; 97.8% run-wide), finances 81.9% (2021v4.2; 95.6% run-wide)
  "990-EZ": { mission: 0.86, finances: 0.73 },
  // 90% of the latest 990-PFs' (134,441) finances: 100.0% run-wide and in every returnVersion
  "990-PF": { finances: 0.9 },
  versionFrom: 200,
  rejects: 0.01,
};

export interface EfileImportOptions {
  /** Holds `{year}/index_{year}.csv` and `{year}/{batch}.zip`. */
  baseUrl: string;
  /** The current year; when its index isn't published yet (January), the run starts a year earlier. */
  latestYear: number;
  /**
   * Index XML_BATCH_IDs whose filings alone are loaded, leaving every other
   * stored filing as it is; omitted, every batch is loaded, and the filings
   * this run didn't write (but those of EINs whose latest return it rejected)
   * are deleted, with the orgs that leaves without a fact or a filing.
   */
  batches?: readonly string[];
  floors: EfileFloors;
  /** Where batch zips are downloaded, one at a time, each deleted once read. */
  workDir: string;
  /** Where the generated SQL load file is written. */
  out: string;
  target: D1Target;
  /** Largest statement written, in bytes; defaults under D1's 100 KB limit. A filing too large for one aborts the run. */
  maxStatementBytes?: number;
}

export interface EfileImportSummary {
  /** One per release year read, latest first. */
  indexes: { year: number; url: string; releasedAt: string; rows: number }[];
  /** The current year, when its index wasn't published and the run read the three before it. */
  unpublished: number | null;
  /** Index rows of return types not stored (990-T), by type. */
  skipped: Record<string, number>;
  zips: { url: string; releasedAt: string; filings: number }[];
  filings: number;
  /** Object ids of the selected returns skipped, by why. */
  rejects: Partial<Record<RejectReason, string[]>>;
  /** Returns selected of each form, rejected ones included, over which `yields` are measured. */
  returns: Record<FormType, number>;
  /** Null for a form the run selected none of. */
  yields: { [F in FormType]: FormYields[F] | null };
}

type FilingColumn = (typeof COLUMNS.filings)[number];
type ProgramColumn = (typeof COLUMNS.programs)[number];
const FILINGS: DataTable = "filings";
const PROGRAMS: DataTable = "programs";

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
  "mission_on_schedule_o",
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
 * file, applied to D1 in a single `wrangler d1 execute --file`. A return
 * whose EIN, form type, an amount or its TaxYr can't be read is rejected and
 * skipped. A drifted index, an unreadable return, a filing missing from its
 * batch or too large for a statement, a failed download, too many rejects or
 * a yield under the floors throws before the apply, leaving D1 untouched and
 * no load file behind.
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
  await options.target.ops.applyFile(options.target.binding, options.out);
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
  const { baseUrl, latestYear, floors } = options;
  const tally: IndexTally = { rows: 0, skipped: {} };
  const indexes: EfileImportSummary["indexes"] = [];
  const fetchedAt = new Date().toISOString();
  const indexFile = (year: number): ImportFile => ({
    source: "efile_index",
    label: "990 index",
    url: `${baseUrl}${year}/index_${year}.csv`,
  });

  const current = await downloadIfPresent(indexFile(latestYear));
  const firstYear = current === null ? latestYear - 1 : latestYear;
  async function* listed(): AsyncGenerator<IndexedFiling> {
    for (let year = firstYear; year > firstYear - RELEASE_YEARS; year--) {
      const file = indexFile(year);
      const { body, releasedAt } =
        year === latestYear && current !== null
          ? current
          : await download(file);
      const before = tally.rows;
      yield* indexedFilings(file, year, Readable.fromWeb(body), tally);
      indexes.push({
        year,
        url: file.url,
        releasedAt,
        rows: tally.rows - before,
      });
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
  const groups = batchGroups(latest, options.batches);
  const selected = groups.reduce((n, group) => n + group.wanted.size, 0);
  let filingsLoaded = 0;
  const yields = new YieldCounts();
  const rejects: EfileImportSummary["rejects"] = {};
  const rejectedEins: string[] = [];
  const budget = options.maxStatementBytes ?? MAX_STATEMENT_BYTES;
  for (const group of groups) {
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
        const accepted = parsedFilings(
          file,
          path,
          group.wanted,
          budget,
          (reject) => {
            (rejects[reject.reason] ??= []).push(reject.filing.objectId);
            rejectedEins.push(reject.filing.ein);
            yields.add(reject.filing.formType, reject.returnVersion, null);
          },
        );
        for await (const batch of batches(
          accepted,
          (p) => p.tuples,
          upsertFilings([]),
          budget,
        )) {
          yield* filingsSql(batch);
          for (const { parsed } of batch) {
            filings++;
            yields.add(parsed.formType, parsed.returnVersion, parsed);
          }
        }
        yield setRowCount("efile_xml", filings);
        zips.push({ url: file.url, releasedAt, filings });
        filingsLoaded += filings;
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

  const rejected = rejectedEins.length;
  if (rejected > floors.rejects * selected) {
    const reasons = Object.entries(rejects)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([reason, ids]) => `${reason}: ${ids.length}`)
      .join(", ");
    throw new Error(
      `990 import aborted: ${rejected} of ${selected} latest filings rejected (${percent(rejected / selected)}), above the ${percent(floors.rejects)} allowed (${reasons}); nothing was loaded`,
    );
  }
  yields.check(floors, options.batches === undefined);
  if (options.batches === undefined) {
    yield* deleteStale(rejectedEins);
  }
  return {
    indexes,
    unpublished: current === null ? latestYear : null,
    skipped: tally.skipped,
    zips,
    filings: filingsLoaded,
    rejects,
    returns: yields.returns(),
    yields: yields.shares(),
  };
}

const FORM_TYPES = Object.keys(FORM_YIELDS) as FormType[];

/** What a run's error messages call a form, before its plural s. */
const FORM_NAMES: Record<FormType, string> = {
  "990": "Form 990",
  "990-EZ": "990-EZ",
  "990-PF": "990-PF",
};

function perForm<T>(make: (form: FormType) => T): Record<FormType, T> {
  return Object.fromEntries(
    FORM_TYPES.map((form) => [form, make(form)]),
  ) as Record<FormType, T>;
}

/** Yields of each form, for the run and per returnVersion. */
class YieldCounts {
  readonly total = perForm((form) => new Yields(form));
  readonly byVersion = perForm(() => new Map<string, Yields>());

  /** Counts one return: `parsed` null for a rejected one, which yields nothing. */
  add(
    form: FormType,
    returnVersion: string | null,
    parsed: ParsedReturn | null,
  ): void {
    const versions = this.byVersion[form];
    const version = returnVersion ?? "unknown";
    let counts = versions.get(version);
    if (counts === undefined) {
      counts = new Yields(form);
      versions.set(version, counts);
    }
    this.total[form].add(parsed);
    counts.add(parsed);
  }

  returns(): Record<FormType, number> {
    return perForm((form) => this.total[form].returns);
  }

  shares(): EfileImportSummary["yields"] {
    return perForm((form) =>
      this.total[form].returns === 0 ? null : this.total[form].shares(),
    ) as EfileImportSummary["yields"];
  }

  /**
   * Throws when a form, or a returnVersion with `floors.versionFrom` returns
   * of it or more, falls below its floors. A form with no returns falls below
   * them on a full run, where its stored filings would otherwise be deleted;
   * a `--batch` run need not hold every form.
   */
  check(floors: EfileFloors, fullRun: boolean): void {
    for (const form of FORM_TYPES) {
      if (fullRun || this.total[form].returns > 0) {
        this.total[form].check(floors, "");
      }
      const versions = [...this.byVersion[form]].sort(([a], [b]) =>
        a < b ? -1 : 1,
      );
      for (const [version, yields] of versions) {
        if (yields.returns >= floors.versionFrom) {
          yields.check(floors, `returnVersion ${version}: `);
        }
      }
    }
  }
}

class Yields {
  returns = 0;
  readonly form: FormType;
  readonly #stated = new Map<YieldName, number>();
  readonly #held: readonly YieldName[];

  constructor(form: FormType) {
    this.form = form;
    this.#held = FORM_YIELDS[form];
  }

  add(parsed: ParsedReturn | null): void {
    this.returns++;
    for (const name of this.#held) {
      if (parsed !== null && YIELDS[name].in(parsed)) {
        this.#stated.set(name, (this.#stated.get(name) ?? 0) + 1);
      }
    }
  }

  /** Each yield's share of `returns`, which must be more than 0. */
  shares(): Partial<Record<YieldName, number>> {
    return Object.fromEntries(
      this.#held.map((name) => [
        name,
        (this.#stated.get(name) ?? 0) / this.returns,
      ]),
    );
  }

  check(floors: EfileFloors, which: string): void {
    const floor: Partial<Record<YieldName, number>> = floors[this.form];
    const floored = this.#held
      .map((name) => percent(floor[name] ?? 0))
      .join(" and ");
    if (this.returns === 0) {
      throw new Error(
        `990 import aborted: ${which}the run selected no ${FORM_NAMES[this.form]}s, below the floor of ${floored}; nothing was loaded`,
      );
    }
    const shares = this.shares();
    const below = this.#held.some(
      (name) => (shares[name] ?? 0) < (floor[name] ?? 0),
    );
    if (!below) return;
    const stated = this.#held
      .map(
        (name, i) =>
          `${percent(shares[name] ?? 0)} ${i === 0 ? "state " : ""}${YIELDS[name].states}`,
      )
      .join(" and ");
    throw new Error(
      `990 import aborted: ${which}of ${this.returns} ${FORM_NAMES[this.form]}s, ${stated}, below the floor of ${floored}; nothing was loaded`,
    );
  }
}

/** EINs per stale-filing DELETE, which names them in a NOT IN list. */
const KEPT_PER_DELETE = 1_000;

/**
 * A full run's tail: deletes the filings it didn't write, except those of
 * EINs whose latest return it rejected, then the orgs left with no fact and no
 * filing (the nameless rows earlier runs added for those filings).
 */
function* deleteStale(rejectedEins: readonly string[]): Generator<string> {
  // every filing this run wrote cites a zip run newer than its index runs
  const stale = `run_id < ${latestRun("efile_index")}`;
  const kept = [...rejectedEins].sort();
  let after = "";
  for (let i = 0; i < kept.length; i += KEPT_PER_DELETE) {
    const chunk = kept.slice(i, i + KEPT_PER_DELETE);
    const through = chunk.at(-1) ?? after;
    yield `DELETE FROM ${FILINGS} WHERE ${stale} AND ein > ${literal(after)} AND ein <= ${literal(through)} AND ein NOT IN (${chunk.map(literal).join(", ")});\n`;
    after = through;
  }
  yield `DELETE FROM ${FILINGS} WHERE ${stale} AND ein > ${literal(after)};\n`;
  const factless = COLUMNS.orgs
    .filter((column) => column !== org("ein"))
    .map((column) =>
      column === org("in_pub78") || column === org("files_990n")
        ? `${column} = 0`
        : `${column} IS NULL`,
    );
  yield `DELETE FROM ${ORGS} WHERE ${factless.join(" AND ")} AND NOT EXISTS (SELECT 1 FROM ${FILINGS} f WHERE f.ein = ${ORGS}.ein);\n`;
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
  /** Both kinds of tuple together: what sizes the statements that hold them. */
  tuples: string;
}

/** A wanted filing skipped on its own. */
interface Reject {
  filing: IndexedFiling;
  reason: RejectReason;
  returnVersion: string | null;
}

/**
 * The wanted filings in the zip at `path`, each removed from `wanted` once
 * read; a return rejected on its own goes to `onReject` instead. One too large
 * for a `budget`-byte statement throws.
 */
async function* parsedFilings(
  file: ImportFile,
  path: string,
  wanted: Map<string, IndexedFiling>,
  budget: number,
  onReject: (reject: Reject) => void,
): AsyncGenerator<Parsed> {
  const fixedBytes = Buffer.byteLength(upsertFilings([]));
  for await (const entry of zipEntries(path)) {
    const objectId = /^(?:.*\/)?(\d{18})_public\.xml$/.exec(entry.name)?.[1];
    const filing = objectId === undefined ? undefined : wanted.get(objectId);
    if (objectId === undefined || filing === undefined) continue;
    wanted.delete(objectId);
    let parsed: ParsedReturn;
    try {
      parsed = await parseReturn(entry.read());
    } catch (error) {
      if (error instanceof RejectedReturn) {
        onReject({
          filing,
          reason: error.reason,
          returnVersion: error.returnVersion,
        });
        continue;
      }
      throw new Error(
        `990 return ${objectId} in ${file.url} unreadable: ${error instanceof Error ? error.message : error}`,
        { cause: error },
      );
    }
    const mismatch =
      parsed.ein !== filing.ein
        ? "EIN mismatch"
        : parsed.formType !== filing.formType
          ? "form type mismatch"
          : null;
    if (mismatch !== null) {
      onReject({
        filing,
        reason: mismatch,
        returnVersion: parsed.returnVersion,
      });
      continue;
    }
    const filingSql = filingTuple(filing, parsed);
    const programsSql = programTuples(filing, parsed);
    const tuples = [filingSql, ...programsSql].join(",\n");
    const bytes = fixedBytes + Buffer.byteLength(tuples);
    if (bytes > budget) {
      throw new Error(
        `990 return ${objectId} in ${file.url} needs a ${bytes}-byte statement, over the ${budget}-byte budget; nothing was loaded`,
      );
    }
    yield {
      filing,
      parsed,
      filingTuple: filingSql,
      programTuples: programsSql,
      tuples,
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
    parsed.missionOnScheduleO ? 1 : 0,
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
FROM (VALUES ${tuples.join(",\n")}) AS v, (SELECT ${latestRun("efile_xml")} AS id) AS r WHERE true
ON CONFLICT (ein) DO UPDATE SET ${updates.join(", ")};\n`;
}
