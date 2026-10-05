import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Client } from "@libsql/client";
import {
  holdsBuild,
  readDataMeta,
  readServedDatabase,
  type ServedDatabase,
  type ServedPointer,
  type SwitchResult,
  switchServedDatabase,
} from "@nonprofits/db";
import { dataDbClient } from "@nonprofits/db/node";
import { printable } from "./summary.ts";
import { RED_CROSS } from "./verify.ts";

/**
 * Where data databases are made, filled and removed: Turso's Platform API, or
 * a local directory of files. A name is a database's identity on its host; the
 * url is what a client, and the pointer, open it by.
 */
export interface DatabaseHost {
  /**
   * Values never to be printed: the host's credentials, and each token it
   * mints, added as it mints them. The same array throughout, so a summary
   * writer handed it at the start redacts tokens minted later.
   */
  readonly secrets: readonly string[];
  /** Makes an empty database named `name`, ready for `upload`; fails if one by that name exists. */
  create(name: string, signal?: AbortSignal): Promise<ServedDatabase>;
  /** Replaces `database`'s contents with the SQLite file at `file`. */
  upload(
    database: ServedDatabase,
    file: string,
    signal?: AbortSignal,
  ): Promise<void>;
  /** A client on `database`, able to read it: one this host made, or the one served. */
  open(database: ServedDatabase): Promise<Client>;
  /** Removes the database named `name`; resolves once it is gone, also when it already was. */
  remove(name: string): Promise<void>;
  /** The shell command an operator runs to remove `name` by hand. */
  removeCommand(name: string): string;
}

export interface PublishOptions {
  /** The app database, holding the served-database pointer. */
  app: Client;
  host: DatabaseHost;
  /** A built file that passed verify: `BuildReport.out`. */
  file: string;
  buildId: string;
  /** Receives one line per step, every one of `host.secrets` redacted. */
  log?: (line: string) => void;
  /** Stops the publish before the switch as a failure would, removing the new database; after it, leaves the previous database in place, with its removal command. */
  signal?: AbortSignal;
  /** Waits `ms`, the grace period, rejecting if `signal` aborts first; a timer unless given. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * How long the previous database outlives the switch before it is removed:
 * twice `POINTER_TTL_MS` in packages/api/src/data-db.ts, since an api instance
 * whose re-read of the pointer fails keeps serving the database it read last.
 */
export const POINTER_GRACE_MS = 60_000;

export interface PublishReport {
  /** The database now served. */
  database: ServedDatabase;
  /** The database served before, or null for a first publish. */
  previous: ServedDatabase | null;
  /** The command that removes `previous`, when it was left in place: its removal failed, or a stop came during the grace period. Null once it is gone. */
  cleanup: string | null;
}

/**
 * Publishes a built file as the served data database: creates a database on
 * `host`, uploads the file, checks the uploaded copy, switches the pointer to
 * it, then removes the previous one.
 *
 * A failure before the switch removes the new database and leaves the pointer
 * and the served database untouched. Every line logged and every message
 * thrown has `host.secrets` redacted; a thrown error carries no cause.
 */
export async function publishDataFile(
  options: PublishOptions,
): Promise<PublishReport> {
  const { host, log = () => {} } = options;
  // a log that throws must not fail a step, whose failure removes the new database
  const say = (line: string) => {
    try {
      log(printable(line, host.secrets));
    } catch {
      // the line is lost; the publish goes on
    }
  };
  try {
    return await publish(options, say);
  } catch (error) {
    throw new Error(printable(errorMessage(error), host.secrets));
  }
}

async function publish(
  {
    app,
    host,
    file,
    buildId,
    signal,
    sleep = (ms, stop) => delay(ms, undefined, { signal: stop }),
  }: PublishOptions,
  say: (line: string) => void,
): Promise<PublishReport> {
  const unlessStopped = () => {
    if (signal?.aborted)
      throw new Error(`stopped: ${errorMessage(signal.reason)}`);
  };
  await withinCap(file);
  const tails = await readLocal(file, lastRows);
  const before = await readServedDatabase(app);
  const name = dataDatabaseName(buildId);
  unlessStopped();
  const database = await failsAs(`creating ${name}`, () =>
    host.create(name, signal),
  );
  say(`created ${name}`);
  /** Runs a step before the switch: its failure removes the new database. */
  const orRemove = async (run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      throw await removedAfter(error, host, name, say);
    }
  };
  await orRemove(async () => {
    unlessStopped();
    await failsAs(`uploading ${file} to ${name}`, () =>
      host.upload(database, file, signal),
    );
  });
  say(`uploaded ${file} to ${name}`);
  await orRemove(async () => {
    unlessStopped();
    await failsAs(`checking the uploaded ${name}`, async () =>
      checkUploaded(await host.open(database), buildId, tails),
    );
  });
  say(
    `checked ${name}: build ${buildId}, every table's last row as the file's`,
  );
  await orRemove(async () => unlessStopped());
  let result: SwitchResult;
  try {
    result = await switchServedDatabase(app, {
      expected: before.database?.name ?? null,
      to: database,
      buildId,
    });
  } catch (error) {
    result = await afterFailedSwitch(error, app, host, name, say);
  }
  if (!result.switched) {
    const { pointer } = result;
    throw await removedAfter(
      new Error(
        `another publish switched to ${pointer.database?.name ?? "nothing"} first, serving build ${pointer.build_id}`,
      ),
      host,
      name,
      say,
    );
  }
  say(`switched to ${name}, serving build ${buildId}`);
  const previous = before.database;
  const retire = async (name: string) => {
    say(
      `waiting ${POINTER_GRACE_MS / 1000} s for api instances to drop ${name}`,
    );
    await sleep(POINTER_GRACE_MS, signal);
    await host.remove(name);
  };
  return {
    database,
    previous,
    cleanup:
      previous && (await removePrevious(host, previous.name, retire, say)),
  };
}

/**
 * The switch to `name` threw, which a write that committed can do as its
 * answer is lost: the pointer, read again, decides. Naming `name`, the switch
 * happened; naming another, the new database is removed; unread, it is kept,
 * since it may be served.
 */
async function afterFailedSwitch(
  failure: unknown,
  app: Client,
  host: DatabaseHost,
  name: string,
  say: (line: string) => void,
): Promise<SwitchResult> {
  const failed = `switching to ${name} failed: ${errorMessage(failure)}`;
  let pointer: ServedPointer;
  try {
    pointer = await readServedDatabase(app);
  } catch (error) {
    const kept = `the pointer is unread (${errorMessage(error)}), so ${name} kept: unless the pointer names it, \`${host.removeCommand(name)}\` removes it`;
    say(`WARNING: ${kept}`);
    throw new Error(`${failed}; ${kept}`);
  }
  if (pointer.database?.name !== name) {
    throw await removedAfter(new Error(failed), host, name, say);
  }
  say(`${failed}, but the pointer names it: it serves`);
  return { switched: true, pointer };
}

/**
 * Retires the database served before, if it is a data database. A failure,
 * or a stop during the wait, leaves it beside the served one, holding
 * storage, and is logged with the command that removes it, which is
 * returned. Never fails: the new database already serves.
 */
async function removePrevious(
  host: DatabaseHost,
  name: string,
  retire: (name: string) => Promise<void>,
  say: (line: string) => void,
): Promise<string | null> {
  // the host would refuse it too; skipped here, it costs no wait and offers no command
  if (!isDataDatabaseName(name)) {
    say(
      `WARNING: not removing ${name}, served before: only a database named ${DATA_DATABASE_PREFIX}… is the import's`,
    );
    return null;
  }
  try {
    await retire(name);
    say(`removed ${name}, served before`);
    return null;
  } catch (error) {
    const command = host.removeCommand(name);
    say(
      `WARNING: could not remove ${name}, served before (${errorMessage(error)}); it holds storage, and the next swap may not fit, until \`${command}\` is run`,
    );
    return command;
  }
}

/**
 * `failure`, once the half-made database `name` is removed; when that fails
 * too, both, with the command that removes it by hand.
 */
async function removedAfter(
  failure: unknown,
  host: DatabaseHost,
  name: string,
  say: (line: string) => void,
): Promise<Error> {
  try {
    await host.remove(name);
    say(`removed ${name}: nothing was switched`);
    return new Error(
      `${errorMessage(failure)}; ${name} removed, nothing switched`,
    );
  } catch (error) {
    const left = `could not remove ${name} (${errorMessage(error)}); it holds storage until \`${host.removeCommand(name)}\` is run`;
    say(`WARNING: ${left}`);
    return new Error(`${errorMessage(failure)}; nothing switched, but ${left}`);
  }
}

/**
 * The largest file a publish uploads. The free Turso plan caps storage at
 * 5 GB, and a swap briefly holds two data databases and the app database.
 */
export const MAX_FILE_BYTES = 2_400_000_000;

async function withinCap(file: string): Promise<void> {
  const { size } = await stat(file);
  if (size > MAX_FILE_BYTES) {
    throw new Error(
      `${file} is ${gigabytes(size)}, over the ${gigabytes(MAX_FILE_BYTES)} cap: a swap holds it, the served database and the app database within the free plan's 5 GB`,
    );
  }
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB (${bytes} bytes)`;
}

/** The prefix every data database's name starts with. */
export const DATA_DATABASE_PREFIX = "nonprofits-data-";

/** Whether `name` is a data database's, the only kind the import removes. */
export function isDataDatabaseName(name: string): boolean {
  return name.startsWith(DATA_DATABASE_PREFIX);
}

/**
 * Throws unless `name` is a data database's. Every host's `remove` calls it
 * first: the Platform token's delete scope reaches every database in the
 * group, the app database's too.
 */
export function onlyDataDatabase(name: string): void {
  if (!isDataDatabaseName(name)) {
    throw new Error(
      `not removing ${name}: only a database named ${DATA_DATABASE_PREFIX}… is the import's`,
    );
  }
}

/** The data database `buildId` is published as: lowercase letters, digits and dashes, as Turso names allow. */
export function dataDatabaseName(buildId: string): string {
  return `${DATA_DATABASE_PREFIX}${buildId.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

/** The tables whose last row the uploaded copy must share with the file. */
const TABLES = ["orgs", "filings", "programs"] as const;

/** Each table's largest rowid, null when it is empty. */
type LastRows = Record<(typeof TABLES)[number], number | null>;

/**
 * Each of `TABLES`' largest rowid, each read by one seek: a count scans every
 * row, which on Turso, over millions, can outlast undici's 300 s
 * headers timeout.
 */
async function lastRows(data: Client): Promise<LastRows> {
  const rows = {} as LastRows;
  for (const table of TABLES) {
    const rs = await data.execute(`SELECT max(rowid) AS n FROM ${table}`);
    const n = rs.rows[0]?.n;
    rows[table] = n === null || n === undefined ? null : Number(n);
  }
  return rows;
}

/** Runs `read` on a client on the local `file`, closing it after. */
async function readLocal<T>(
  file: string,
  read: (data: Client) => Promise<T>,
): Promise<T> {
  const data = dataDbClient(pathToFileURL(file).href, {});
  try {
    return await read(data);
  } finally {
    data.close();
  }
}

/**
 * Checks the uploaded copy is the file, by seeks alone: it holds `buildId`,
 * answers the Red Cross, and ends each table on the file's last row. The data
 * itself was verified, counts included, on the file; this proves the upload.
 */
async function checkUploaded(
  data: Client,
  buildId: string,
  tails: LastRows,
): Promise<void> {
  try {
    const meta = await readDataMeta(data);
    if (!holdsBuild(buildId, meta)) {
      throw new Error(
        meta
          ? `it holds build ${meta.build_id}, not ${buildId}`
          : `it holds no finished build, not ${buildId}`,
      );
    }
    const redCross = await data.execute({
      sql: "SELECT 1 FROM orgs WHERE ein = ?",
      args: [RED_CROSS],
    });
    if (redCross.rows.length === 0)
      throw new Error(`it has no org ${RED_CROSS}`);
    const uploaded = await lastRows(data);
    const differ = TABLES.filter(
      (table) => uploaded[table] !== tails[table],
    ).map(
      (table) =>
        `${table}: last rowid ${uploaded[table]}, the file's ${tails[table]}`,
    );
    if (differ.length > 0) {
      throw new Error(
        `its last rows differ from the file's: ${differ.join("; ")}`,
      );
    }
  } finally {
    data.close();
  }
}

/** Runs `run`; a failure is rethrown led by what was being done. */
async function failsAs<T>(doing: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(`${doing} failed: ${errorMessage(error)}`);
  }
}

/**
 * `error`'s message, and its cause's: fetch fails with "fetch failed" alone,
 * its reason (undici's code and message) in `cause`. Redacted with the rest
 * where it is printed.
 */
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { cause } = error;
  if (!(cause instanceof Error)) return error.message;
  const code = (cause as { code?: unknown }).code;
  const why =
    typeof code === "string" ? `${code}: ${cause.message}` : cause.message;
  return `${error.message} (${why})`;
}
