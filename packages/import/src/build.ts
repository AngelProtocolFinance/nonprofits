import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Client } from "@libsql/client";
import { createDataDatabase, finishDataDatabase } from "@nonprofits/db";
import { dataDbClient } from "@nonprofits/db/node";
import { loadSource, SOURCES, type SourceConfig } from "./sources.ts";
import { fileTarget } from "./target.ts";
import {
  type Check,
  type Counts,
  checker,
  type ReadData,
  type TableFloors,
  verifyData,
  verifyFailure,
} from "./verify.ts";

/**
 * The file format Turso's upload takes. Page size and auto-vacuum are fixed
 * when the first page is written, which setting WAL does: one call, so one
 * connection, sets all three.
 */
const UPLOAD_FORMAT =
  "PRAGMA page_size = 4096; PRAGMA auto_vacuum = NONE; PRAGMA journal_mode = WAL;";

/** A client on a new data database file at `path`, in Turso's upload format, its schema built and empty. */
export async function createDataFile(path: string): Promise<Client> {
  await mkdir(dirname(path), { recursive: true });
  const data = dataDbClient(pathToFileURL(path).href, {});
  try {
    await data.executeMultiple(UPLOAD_FORMAT);
    await createDataDatabase(data);
    return data;
  } catch (error) {
    data.close();
    throw error;
  }
}

export interface BuildOptions {
  sources: SourceConfig;
  floors: TableFloors;
  /** Where the finished file is put. Nothing is there unless the build passed verify: a file there already is removed first. */
  out: string;
  /** Where each source's SQL load file is written. */
  loadDir: string;
  /** The served build's counts, each of the new build's to be within 10% of; omitted, the floors alone are checked. */
  served?: Counts | undefined;
  /** Adds a check that always fails, after every real one: the whole build runs and is then thrown away. */
  forceVerifyFailure?: boolean;
  /** Receives one line per step as the build goes. */
  log?: (line: string) => void;
}

export interface BuildReport {
  buildId: string;
  /** The finished file: `BuildOptions.out`. */
  out: string;
  counts: Counts;
  checks: Check[];
}

/**
 * Builds one month's data into a new SQLite file in Turso's upload format:
 * every source in order, each its own load → the search index and
 * `data_meta`, once → verify → a WAL checkpoint, so the file alone holds the
 * data. It is built beside `out` and moved there only once verify passed; any
 * failure deletes it and throws, leaving nothing at `out`.
 *
 * `sources.efile.batches` builds a partial file, which only clears verify with
 * the filings and programs floors waived; never publish one.
 */
export async function buildDataFile({
  sources,
  floors,
  out,
  loadDir,
  served,
  forceVerifyFailure = false,
  log = () => {},
}: BuildOptions): Promise<BuildReport> {
  const buildId = buildIdNow();
  const building = `${out}.building`;
  await removeFile(out);
  await removeFile(building);
  await mkdir(loadDir, { recursive: true });
  log(`building ${buildId} in ${building}`);
  let opened: Client | undefined;
  try {
    const data = await createDataFile(building);
    opened = data;
    for (const source of SOURCES) {
      await step(log, `loaded ${source}`, async () => {
        const loaded = await loadSource(
          source,
          sources,
          fileTarget(data),
          join(loadDir, `${source}.load.sql`),
        );
        for (const line of loaded.lines) log(`  ${line}`);
      });
    }
    await step(log, "indexed for search", () =>
      finishDataDatabase(data, buildId),
    );
    const checks: Check[] = [];
    const counts = await step(log, "verified", async () => {
      const read: ReadData = async <T>(sql: string) =>
        (await data.execute(sql)).rows as unknown as T[];
      const counts = await verifyData(read, {
        floors:
          sources.efile.batches === undefined
            ? floors
            : { ...floors, filings: 0, programs: 0 },
        served,
        forceVerifyFailure,
        check: checker(checks, log),
        log,
      });
      const failed = verifyFailure(`build ${buildId}`, checks);
      if (failed !== null) throw failed;
      return counts;
    });
    await checkpoint(data);
    data.close();
    await rename(building, out);
    // the emptied WAL files left beside the old name
    await removeFile(building);
    log(`built ${buildId} at ${out}`);
    return { buildId, out, counts, checks };
  } catch (error) {
    opened?.close();
    await removeFile(building);
    throw error;
  }
}

/** The id of a build starting now: the time, to the second. */
export function buildIdNow(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/** Moves every page out of the WAL into the file, leaving the WAL empty. */
async function checkpoint(data: Client): Promise<void> {
  const rs = await data.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  const [row] = rs.rows;
  if (row?.busy !== 0) {
    throw new Error(
      `WAL checkpoint incomplete: ${JSON.stringify(row)}; the file would not hold every page`,
    );
  }
}

/** Deletes `path` and the WAL files SQLite keeps beside it, those that exist. */
async function removeFile(path: string): Promise<void> {
  await Promise.all(
    [path, `${path}-wal`, `${path}-shm`].map((file) =>
      rm(file, { force: true }),
    ),
  );
}

/** Runs `run`, logging `done` with how long it took once it succeeds. */
async function step<T>(
  log: (line: string) => void,
  done: string,
  run: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const result = await run();
  log(`${done} (${((performance.now() - started) / 1000).toFixed(1)} s)`);
  return result;
}
