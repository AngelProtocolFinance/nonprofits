import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Client } from "@libsql/client";
import {
  readDataCounts,
  readServedDatabase,
  type ServedPointer,
} from "@nonprofits/db";
import { appDbClient } from "@nonprofits/db/node";
import { buildDataFile } from "./build.ts";
import { databaseHostFor, LOCAL_DATA_DIR } from "./database-host.ts";
import {
  type DatabaseHost,
  dataDatabaseName,
  type PublishOptions,
  type PublishReport,
  publishDataFile,
} from "./publish.ts";
import { irsSources, type SourceConfig } from "./sources.ts";
import {
  finish,
  printable,
  type RunRecord,
  readServedAfter,
  runRecord,
  type Secrets,
  summarized,
  summaryWriter,
  timed,
} from "./summary.ts";
import {
  asCounts,
  type Counts,
  TABLE_FLOORS,
  type TableFloors,
} from "./verify.ts";

/** Where `build` and `refresh` put the file they build by default, from the repo root. */
export const DATA_FILE_NAME = "data/nonprofits.db";

const USAGE = `usage: node src/cli.ts <command>
  build [--out <file>] [--efile-batch <XML_BATCH_ID>]... [--force-verify-failure]
      build every IRS source into one new SQLite file in Turso's upload format
      (default ${DATA_FILE_NAME}) and verify it, its counts against the served
      database's while one is served; a file that fails verify is deleted, and
      a build first deletes the file already at --out; --efile-batch loads just
      those e-file batches, a partial file never to publish;
      --force-verify-failure fails verify after the full build
  refresh [--force-verify-failure] [--summary <file>]
      build as above to ${DATA_FILE_NAME}, then publish it: upload it as a new
      data database, switch the served-database pointer to it and delete the
      one served before; --force-verify-failure fails verify after the full
      build, so nothing is published
  --summary <file>  append a markdown summary of the run to <file>, failed or stopped too
The app database is TURSO_APP_DB_URL (.turso/app.db when unset). A Turso Cloud
one publishes through Turso's Platform API, with TURSO_APP_DB_TOKEN,
TURSO_PLATFORM_TOKEN, TURSO_ORG and TURSO_GROUP; any other to files in .turso/data/.`;

/** The flags each command takes. */
const FLAGS = {
  build: ["out", "efile-batch", "force-verify-failure"],
  refresh: ["force-verify-failure", "summary"],
} as const;

function repoPath(path: string): string {
  return fileURLToPath(new URL(`../../../${path}`, import.meta.url));
}

class UsageError extends Error {}

function args(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: {
        out: { type: "string" },
        "efile-batch": { type: "string", multiple: true },
        summary: { type: "string" },
        "force-verify-failure": { type: "boolean" },
      },
      allowPositionals: true,
    });
  } catch (error) {
    // an unknown or malformed flag
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

type Values = ReturnType<typeof args>["values"];

type Env = Readonly<Record<string, string | undefined>>;

/** The app database, holding the served-database pointer, and the host of the data databases it serves. */
export interface Databases {
  app: Client;
  host: DatabaseHost;
}

/** Where the run prints free text that can quote an error: redacted and clipped as the summary is. */
interface Terminal {
  /** stdout; quiet once a signal is stopping the run, as its failures are the stop's. */
  log(text: string): void;
  /** stderr. */
  error(text: string): void;
}

/** What `run` reaches beyond its arguments; the CLI's own entry passes the real ones. */
export interface CliDeps {
  /** The databases `env` names, opened once per run, which closes `app`. */
  databases(env: Env): Databases;
  /** Every IRS source; e-file from `batches` alone when given. */
  sources(batches: readonly string[] | undefined): SourceConfig;
  /** The fewest of each count a build may hold. */
  floors: TableFloors;
  /** Where the load files are written. */
  loadDir: string;
  /** Where `refresh`, and `build` without --out, builds its file. */
  dataFile: string;
  /** As `PublishOptions.sleep`: a timer unless given. */
  sleep?: PublishOptions["sleep"];
  /** Has `stop` called on every SIGINT (code 130) and SIGTERM (143). */
  onSignal(stop: (signal: NodeJS.Signals, code: number) => void): void;
  /** Ends the process, once a stop is done. */
  exit(code: number): void;
}

/** What one run shares between its command and a stop. */
interface Session {
  deps: CliDeps;
  terminal: Terminal;
  /** The values every printed line and the summary redact, read at print time. */
  secrets: () => Secrets;
  /** The run's databases, opened on the first call. */
  open: () => Databases;
  /** Called once a signal starts stopping the run, with the stop's exit code and its cleanup. */
  onStop: (code: number, stopped: Promise<void>) => void;
}

/**
 * Runs the CLI on `argv` (the args after the script); resolves with its exit
 * code: 0 done, 1 failed, 2 usage, or the stop's 130 or 143 once a signal is
 * stopping it. `env` names the databases and supplies the secrets the
 * summary and the terminal redact.
 */
export async function run(
  argv: readonly string[],
  env: Env,
  deps: CliDeps,
): Promise<number> {
  /** The stop's exit code, set by a SIGINT or SIGTERM, so the run's own failure isn't reported over it. */
  let stoppedWith: number | null = null;
  let stopped: Promise<void> | null = null;
  let opened: Databases | undefined;
  const secrets = () => [
    env.TURSO_APP_DB_TOKEN,
    env.TURSO_PLATFORM_TOKEN,
    ...(opened?.host.secrets ?? []),
  ];
  const terminal: Terminal = {
    log: (text) => {
      if (stoppedWith === null) console.log(printable(text, secrets()));
    },
    error: (text) => console.error(printable(text, secrets())),
  };
  const session: Session = {
    deps,
    terminal,
    secrets,
    open: () => {
      opened ??= deps.databases(env);
      return opened;
    },
    onStop: (code, cleanup) => {
      stoppedWith = code;
      stopped = cleanup;
    },
  };
  try {
    const code = await command(argv, session);
    // a publish a stop came too late to abort still ends the run as the stop
    return stoppedWith ?? code;
  } catch (error) {
    if (stoppedWith !== null) return stoppedWith;
    if (error instanceof UsageError) {
      if (error.message) terminal.error(error.message);
      console.error(USAGE);
      return 2;
    }
    terminal.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    // the stop reads the pointer through the app database
    await stopped;
    opened?.app.close();
  }
}

async function command(argv: readonly string[], s: Session): Promise<number> {
  const { values, positionals } = args(argv);
  const [name, ...rest] = positionals;
  if ((name !== "build" && name !== "refresh") || rest.length > 0) {
    throw new UsageError();
  }
  if (name === "refresh" && values["efile-batch"] !== undefined) {
    throw new UsageError(
      "refresh publishes only a full build: irs build --efile-batch builds a partial file without publishing it",
    );
  }
  const unexpected = Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([flag]) => flag)
    .filter((flag) => !(FLAGS[name] as readonly string[]).includes(flag));
  if (unexpected.length > 0) {
    throw new UsageError(`${name} takes no --${unexpected.join(", --")}`);
  }
  if (name === "build") {
    await runBuild(values, s);
  } else {
    await runRefresh(values, s);
  }
  return 0;
}

async function runBuild(values: Values, s: Session): Promise<void> {
  const batches = values["efile-batch"];
  let served: Counts | undefined;
  // a partial file holds a fraction of the filings any served build does
  if (batches === undefined) {
    const { app, host } = s.open();
    served = await servedCounts(await readServedDatabase(app), host);
  }
  const report = await buildDataFile({
    sources: s.deps.sources(batches),
    floors: s.deps.floors,
    out: values.out ?? s.deps.dataFile,
    loadDir: s.deps.loadDir,
    served,
    forceVerifyFailure: values["force-verify-failure"] === true,
    log: s.terminal.log,
  });
  console.log(
    `build: ${report.out}, build ${report.buildId} (${listed(report.counts)})`,
  );
}

/** Builds, verifies against what is served, and publishes; writes the run's summary, failed or stopped too. */
async function runRefresh(values: Values, s: Session): Promise<void> {
  const record = runRecord();
  const write =
    values.summary === undefined
      ? () => {}
      : summaryWriter(values.summary, s.secrets);
  let databases: Databases | undefined;
  const readServed = async () =>
    databases === undefined ? null : readServedDatabase(databases.app);
  const underStop = stopOnSignal(record, write, readServed, s);
  const log = s.terminal.log;
  await summarized(record, write, readServed, async () => {
    databases = s.open();
    const { app, host } = databases;
    const before = await readServedDatabase(app);
    record.servedBefore = before;
    const served = await timed(
      log,
      record.steps,
      "read the served counts",
      () => servedCounts(before, host),
    );
    const report = await buildDataFile({
      sources: s.deps.sources(undefined),
      floors: s.deps.floors,
      out: s.deps.dataFile,
      loadDir: s.deps.loadDir,
      served,
      forceVerifyFailure: values["force-verify-failure"] === true,
      log,
      record,
    });
    const published = await timed(log, record.steps, "published", () =>
      underStop(host, report.buildId, (signal) =>
        publishDataFile({
          app,
          host,
          file: report.out,
          buildId: report.buildId,
          log,
          signal,
          ...(s.deps.sleep === undefined ? {} : { sleep: s.deps.sleep }),
        }),
      ),
    );
    console.log(
      `refresh: serving ${published.database.name}, build ${report.buildId} (${listed(report.counts)})`,
    );
  });
}

/**
 * The counts the build `pointer` serves recorded, read from its one
 * `data_meta` row: undefined while it serves none, or one that recorded none.
 */
async function servedCounts(
  pointer: ServedPointer,
  host: DatabaseHost,
): Promise<Counts | undefined> {
  if (pointer.database === null) return undefined;
  const data = await host.open(pointer.database);
  try {
    const recorded = await readDataCounts(data);
    return recorded === undefined ? undefined : asCounts(recorded);
  } finally {
    data.close();
  }
}

function listed(counts: Counts): string {
  return Object.entries(counts)
    .map(([table, n]) => `${n} ${table}`)
    .join(", ");
}

/**
 * How long a stop may take before the CLI exits anyway: GitHub Actions
 * follows a cancel's SIGINT with SIGTERM 7.5 s later and SIGKILL at 10 s.
 */
const STOP_BUDGET_MS = 7_000;

/** Runs a publish under the run's stop signal, recording its cleanup, so a stop can wait for what it leaves. */
type UnderStop = (
  host: DatabaseHost,
  buildId: string,
  publish: (signal: AbortSignal) => Promise<PublishReport>,
) => Promise<PublishReport>;

/**
 * On SIGINT or SIGTERM: aborts the publish, which removes the database it
 * was making unless the pointer already names it, waits for it, records and
 * prints what the pointer serves, writes the run's summary and exits 130 or
 * 143, within `STOP_BUDGET_MS`. A stop cut off while the publish is still
 * running can't know whether the pointer names the database it was making,
 * so it names that database's removal only beside reading the pointer first,
 * never as the run's cleanup. A stop during the build leaves the build to the
 * exit. A signal while stopping waits for that stop.
 */
function stopOnSignal(
  record: RunRecord,
  write: (record: RunRecord) => void,
  readServed: () => Promise<ServedPointer | null>,
  s: Session,
): UnderStop {
  const controller = new AbortController();
  let publishing: {
    name: string;
    host: DatabaseHost;
    done: Promise<unknown>;
    settled: boolean;
  } | null = null;
  let stopping = false;
  const stop = async (signal: NodeJS.Signals, code: number) => {
    const lines: string[] = [];
    record.stop = { signal, lines };
    const report = (line: string) => {
      lines.push(line);
      s.terminal.error(line);
    };
    console.error(`${signal}: stopping`);
    controller.abort(new Error(signal));
    const cleanedUp = (async () => {
      await publishing?.done.catch(() => {});
      const servedAfter = await readServedAfter(readServed);
      record.servedAfter = servedAfter;
      if (servedAfter !== null) {
        s.terminal.error(
          "unread" in servedAfter
            ? `stopped: the pointer is unread (${servedAfter.unread})`
            : `stopped: serving ${servedAfter.database?.name ?? "no database"}, build ${servedAfter.build_id}`,
        );
      }
      return true;
    })();
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), STOP_BUDGET_MS);
    });
    const done = await Promise.race([cleanedUp, budget]);
    clearTimeout(timer);
    if (!done) {
      const cutOff = `stop cut off after ${STOP_BUDGET_MS / 1000} s`;
      if (publishing === null || publishing.settled) {
        report(cutOff);
      } else {
        const { name, host } = publishing;
        report(
          `${cutOff} publishing ${name}: read what the pointer names first; unless it is ${name}, \`${host.removeCommand(name)}\` removes it`,
        );
      }
    }
    finish(record);
    write(record);
    s.deps.exit(code);
  };
  s.deps.onSignal((signal, code) => {
    if (stopping) {
      console.error(`${signal}: already stopping`);
      return;
    }
    stopping = true;
    s.onStop(code, stop(signal, code));
  });
  return (host, buildId, publish) => {
    const tracked = {
      name: dataDatabaseName(buildId),
      host,
      settled: false,
      done: publish(controller.signal).then(
        (report) => {
          tracked.settled = true;
          record.cleanup = report.cleanup;
          return report;
        },
        (error: unknown) => {
          tracked.settled = true;
          throw error;
        },
      ),
    };
    publishing = tracked;
    return tracked.done;
  };
}

/**
 * The app database `env.TURSO_APP_DB_URL` names, `local.appDb` when it is
 * unset, and the host of its data databases: Turso's Platform API for a Turso
 * Cloud app database, else files in `local.dataDir`.
 */
export function openDatabases(
  env: Env,
  local: { appDb: string; dataDir: string },
): Databases {
  const named = {
    ...env,
    TURSO_APP_DB_URL: env.TURSO_APP_DB_URL || local.appDb,
  };
  // the host first: a Turso Cloud app database missing a Platform setting fails before a client opens
  const host = databaseHostFor(named, local.dataDir);
  return { app: appDbClient(named), host };
}

if (import.meta.main) {
  void run(process.argv.slice(2), process.env, {
    databases: (env) =>
      openDatabases(env, {
        appDb: pathToFileURL(repoPath(".turso/app.db")).href,
        dataDir: LOCAL_DATA_DIR,
      }),
    sources: (batches) =>
      irsSources({
        workDir: repoPath("data/efile"),
        ...(batches === undefined ? {} : { batches }),
      }),
    floors: TABLE_FLOORS,
    loadDir: repoPath("load"),
    dataFile: repoPath(DATA_FILE_NAME),
    onSignal: (stop) => {
      // `on`, not `once`: a second signal left to node's default would kill the stop's cleanup
      process.on("SIGINT", (signal) => stop(signal, 130));
      process.on("SIGTERM", (signal) => stop(signal, 143));
    },
    exit: (code) => process.exit(code),
  }).then((code) => {
    process.exitCode = code;
  });
}
