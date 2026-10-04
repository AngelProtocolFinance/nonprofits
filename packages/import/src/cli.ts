import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DATA_DB_BINDING, type DataSlot, otherSlot } from "@nonprofits/db";
import {
  importAmong,
  keepsClaim,
  readMeta,
  readPointer,
  rebuildSearchIndex,
  refresh,
  releaseAfterStop,
  releaseClaim,
  releaseCommand,
  rollback,
  TABLE_FLOORS,
} from "./generation.ts";
import {
  irsSources,
  isSource,
  loadSource,
  SOURCES,
  type Source,
  type SourceConfig,
} from "./sources.ts";
import {
  finish,
  type KeptClaim,
  type RunRecord,
  runRecord,
  summarized,
  summaryWriter,
} from "./summary.ts";
import {
  type D1Ops,
  localD1,
  remoteD1,
  runningWrangler,
  stopWrangler,
} from "./wrangler.ts";

/** What `all` loads, in order. Not efile: a full 990 run downloads ~10 GB and takes about an hour, so it is asked for by name. */
const ALL = SOURCES.filter((source) => source !== "efile");

const USAGE = `usage: node src/cli.ts <command>
  refresh [--remote] [--efile-batch <XML_BATCH_ID>]... [--force-verify-failure] [--summary <file>]
      build the data slot not served from every IRS source, verify it, seal it
      and serve it; --efile-batch (local only) loads just those e-file batches;
      --force-verify-failure fails verify after the full build, which is then
      neither sealed nor served
  rollback [--remote] [--summary <file>]
      serve the other data slot again, while it holds a complete build that was served before
  release [--remote] [--build <BUILD_ID>]
      clear the claim a stopped build left on the slot not served (only that build's, with --build)
  <bmf|pub78|revocation|epostcard|efile|all> [--slot a|b] [--batch <XML_BATCH_ID>]...
      dev, local only: load into a slot (default: the one not served) that
      pnpm --filter @nonprofits/worker db:reset:local <slot> left building, then
      rebuild its search index; all = ${ALL.join(", ")}
      --batch  efile only: load just the filings in this batch
  --summary <file>    append a markdown summary of the run to <file>, failed or stopped too
  --persist-to <dir>  local D1 state under <dir> instead of wrangler's default`;

/** The flags each command takes, beside --persist-to. */
const FLAGS = {
  refresh: ["remote", "efile-batch", "force-verify-failure", "summary"],
  rollback: ["remote", "summary"],
  release: ["remote", "build"],
  load: ["slot", "batch"],
} as const;

function repoPath(path: string): string {
  return fileURLToPath(new URL(`../../../${path}`, import.meta.url));
}

const LOAD_DIR = repoPath("load");
const EFILE_WORK_DIR = repoPath("data/efile");

class UsageError extends Error {}

function args(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: {
        remote: { type: "boolean" },
        "persist-to": { type: "string" },
        batch: { type: "string", multiple: true },
        "efile-batch": { type: "string", multiple: true },
        slot: { type: "string" },
        build: { type: "string" },
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

/** What `run` reaches beyond its arguments; the CLI's own entry passes the real ones. */
export interface CliDeps {
  /** The deployed databases when `remote`, else local state under `persistTo` (wrangler's default dir when undefined). */
  d1(remote: boolean, persistTo: string | undefined): D1Ops;
  /** Every IRS source; e-file from `batches` alone when given. */
  sources(batches: readonly string[] | undefined): SourceConfig;
  /** Where the load files are written. */
  loadDir: string;
  /** Has `stop` called on every SIGINT (code 130) and SIGTERM (143). */
  onSignal(stop: (signal: NodeJS.Signals, code: number) => void): void;
  /** As `stopWrangler`. */
  stopWrangler(
    then: (killed: readonly (readonly string[])[]) => Promise<void>,
  ): Promise<void>;
  /** As `runningWrangler`. */
  runningWrangler(): readonly (readonly string[])[];
  /** Ends the process, once a stop is done. */
  exit(code: number): void;
}

/**
 * Runs the CLI on `argv` (the args after the script); resolves with its exit
 * code: 0 done, 1 failed, 2 usage, or the stop's 130 or 143 once a signal is
 * stopping it. `env` supplies the secrets a summary redacts.
 */
export async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: CliDeps,
): Promise<number> {
  /** The stop's exit code, set by a SIGINT or SIGTERM, so the run's own failure isn't reported over it. */
  let stoppedWith: number | null = null;
  /** The run's own lines; quiet once a signal is stopping it, as its failures are the stop's. */
  const log = (line: string) => {
    if (stoppedWith === null) console.log(line);
  };
  try {
    return await command(argv, env, deps, log, (code) => {
      stoppedWith = code;
    });
  } catch (error) {
    if (stoppedWith !== null) return stoppedWith;
    if (error instanceof UsageError) {
      if (error.message) console.error(error.message);
      console.error(USAGE);
      return 2;
    }
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}

async function command(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: CliDeps,
  log: (line: string) => void,
  onStop: (code: number) => void,
): Promise<number> {
  const { values, positionals } = args(argv);
  const [name, ...rest] = positionals;
  if (name === undefined || rest.length > 0) throw new UsageError();
  const flags =
    name === "refresh" || name === "rollback" || name === "release"
      ? FLAGS[name]
      : FLAGS.load;
  const given = Object.entries(values)
    .filter(([flag, value]) => value !== undefined && flag !== "persist-to")
    .map(([flag]) => flag);
  const unexpected = given.filter(
    (flag) => !(flags as readonly string[]).includes(flag),
  );
  if (unexpected.length > 0) {
    throw new UsageError(`${name} takes no --${unexpected.join(", --")}`);
  }
  const remote = values.remote === true;
  if (remote && values["persist-to"] !== undefined) {
    throw new UsageError("--persist-to is for local D1 state only");
  }
  const ops = deps.d1(remote, values["persist-to"]);
  const where = remote ? "remote" : "local";

  if (name === "refresh" || name === "rollback") {
    const record = runRecord(name, remote);
    const write =
      values.summary === undefined
        ? () => {}
        : summaryWriter(values.summary, [
            env.CLOUDFLARE_API_TOKEN,
            env.CLOUDFLARE_ACCOUNT_ID,
          ]);
    const claims = releaseOnSignal(ops, record, write, deps, onStop);
    await summarized(ops, record, write, () =>
      name === "refresh"
        ? runRefresh(ops, values, record, claims, deps, log)
        : runRollback(ops, record, claims, log),
    );
    return 0;
  }

  if (name === "release") {
    const claim = await releaseClaim(ops, values.build);
    if (claim === null) {
      console.log(
        values.build === undefined
          ? `release: ${where} D1 has no claim to release`
          : `release: build ${values.build} holds no claim in ${where} D1`,
      );
      return values.build === undefined ? 0 : 1;
    }
    console.log(
      `release: cleared build ${claim.claim_build_id}'s claim on slot ${claim.claim_slot} (claimed ${claim.claimed_at}, lease to ${claim.claim_expires_at})`,
    );
    return 0;
  }

  const sources = name === "all" ? ALL : isSource(name) ? [name] : undefined;
  const slot = values.slot;
  if (
    sources === undefined ||
    (values.batch !== undefined && name !== "efile") ||
    (slot !== undefined && !isSlot(slot))
  ) {
    throw new UsageError();
  }
  if (remote) {
    throw new UsageError(
      "a single-source load is local only: remote data changes go through irs refresh",
    );
  }
  return loadSources(
    ops,
    sources,
    slot,
    values.batch,
    values["persist-to"],
    deps,
  );
}

async function runRefresh(
  ops: D1Ops,
  values: Values,
  record: RunRecord,
  claims: string[],
  deps: CliDeps,
  log: (line: string) => void,
): Promise<void> {
  console.log(`refresh: ${ops.remote ? "remote" : "local"} D1`);
  const report = await refresh(ops, {
    sources: deps.sources(values["efile-batch"]),
    floors: TABLE_FLOORS,
    loadDir: deps.loadDir,
    log,
    onClaim: (buildId) => claims.push(buildId),
    forceVerifyFailure: values["force-verify-failure"] === true,
    record,
  });
  const counts = Object.entries(report.counts)
    .map(([table, n]) => `${n} ${table}`)
    .join(", ");
  console.log(
    `refresh: serving slot ${report.slot}, build ${report.buildId} (${counts}); irs rollback serves slot ${report.previous} again`,
  );
}

async function runRollback(
  ops: D1Ops,
  record: RunRecord,
  claims: string[],
  log: (line: string) => void,
): Promise<void> {
  const { from, to, buildId } = await rollback(ops, {
    log,
    onClaim: (buildId) => claims.push(buildId),
    record,
  });
  console.log(
    `rollback: ${ops.remote ? "remote" : "local"} D1 serving slot ${to} (build ${buildId}) instead of slot ${from}`,
  );
}

function isSlot(name: string): name is DataSlot {
  return name === "a" || name === "b";
}

/**
 * How long a stop may take before the CLI exits anyway: GitHub Actions
 * follows a cancel's SIGINT with SIGTERM 7.5 s later and SIGKILL at 10 s.
 */
const STOP_BUDGET_MS = 7_000;

/**
 * On SIGINT or SIGTERM: stops wrangler (the running command and every later
 * one the run starts), releases every claim the run asked for (a claim it
 * never got releases nothing; one the run kept, or whose remote import the
 * stop killed, is kept and recorded), reports what the pointer serves,
 * records the stop and writes the run's summary, and exits 130 or 143, within
 * `STOP_BUDGET_MS`. A signal while stopping waits for that stop. Returns the
 * list the run adds each build id to as it claims.
 */
function releaseOnSignal(
  ops: D1Ops,
  record: RunRecord,
  write: (record: RunRecord) => void,
  deps: CliDeps,
  onStop: (code: number) => void,
): string[] {
  const claims: string[] = [];
  let stopping = false;
  const keep = (claim: KeptClaim) => {
    if (!record.keptClaims.some((k) => k.buildId === claim.buildId)) {
      record.keptClaims.push(claim);
    }
    console.error(keepsClaim(claim.buildId, claim.binding));
  };
  const stop = async (signal: NodeJS.Signals, code: number) => {
    if (stopping) {
      console.error(`${signal}: already stopping`);
      return;
    }
    stopping = true;
    onStop(code);
    // what the stop kills, read now: a stop cut off before its cleanup has only this to go on
    const running = deps.runningWrangler();
    const lines: string[] = [];
    record.stop = { signal, lines };
    const report = (line: string) => {
      lines.push(line);
      console.error(line);
    };
    console.error(`${signal}: stopping`);
    for (const claim of record.keptClaims) keep(claim);
    const releasable = claims.filter(
      (id) => !record.keptClaims.some((k) => k.buildId === id),
    );
    const stopped = deps
      .stopWrangler((killed) =>
        releaseAfterStop(ops, releasable, killed, { report, keep }),
      )
      .then(() => true);
    const budget = new Promise<false>((resolve) =>
      setTimeout(() => resolve(false), STOP_BUDGET_MS),
    );
    if (!(await Promise.race([stopped, budget]))) {
      report(`stop cut off after ${STOP_BUDGET_MS / 1000} s`);
      const binding = importAmong(ops, running);
      for (const id of releasable) {
        if (binding === undefined) {
          report(
            `${releaseCommand(ops, id)} clears build ${id}'s claim if it is still held`,
          );
        } else {
          keep({ buildId: id, binding });
        }
      }
    }
    finish(record);
    write(record);
    deps.exit(code);
  };
  deps.onSignal((signal, code) => void stop(signal, code));
  return claims;
}

/**
 * Loads into a slot `db:reset:local` left building, under its build's fence.
 * Each source commits on its own, so one failing in `all` still lets the rest load.
 */
async function loadSources(
  ops: D1Ops,
  sources: readonly Source[],
  named: DataSlot | undefined,
  batches: readonly string[] | undefined,
  persistTo: string | undefined,
  deps: CliDeps,
): Promise<number> {
  const { active } = await readPointer(ops);
  const slot = named ?? otherSlot(active);
  if (slot === active) {
    throw new UsageError(`slot ${slot} is the one served`);
  }
  const binding = DATA_DB_BINDING[slot];
  const meta = await readMeta(ops, binding);
  if (meta?.state !== "building") {
    const reset = `pnpm --filter @nonprofits/worker db:reset:local ${slot}${persistTo === undefined ? "" : ` --persist-to ${persistTo}`}`;
    throw new Error(
      `slot ${slot} (${binding}) ${meta === null ? "holds no generation" : `is sealed (build ${meta.build_id})`}: ${reset} resets it for a load`,
    );
  }
  const target = { ops, binding, buildId: meta.build_id };
  const config = deps.sources(batches);
  const failed: Source[] = [];
  for (const source of sources) {
    const out = join(deps.loadDir, `${source}.load.sql`);
    console.error(`importing ${source} into local ${binding} via ${out}`);
    try {
      const { lines } = await loadSource(source, config, target, out);
      for (const line of lines) {
        console.log(line);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      failed.push(source);
    }
  }
  if (failed.length < sources.length) {
    await rebuildSearchIndex(target, deps.loadDir);
    console.log(`rebuilt ${binding}'s search index`);
  }
  if (failed.length > 0) {
    console.error(`not imported: ${failed.join(", ")}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  void run(process.argv.slice(2), process.env, {
    d1: (remote, persistTo) => (remote ? remoteD1() : localD1(persistTo)),
    sources: (batches) =>
      irsSources({
        workDir: EFILE_WORK_DIR,
        ...(batches === undefined ? {} : { batches }),
      }),
    loadDir: LOAD_DIR,
    onSignal: (stop) => {
      // `on`, not `once`: a second signal left to node's default would kill the stop's cleanup
      process.on("SIGINT", (signal) => stop(signal, 130));
      process.on("SIGTERM", (signal) => stop(signal, 143));
    },
    stopWrangler,
    runningWrangler,
    exit: (code) => process.exit(code),
  }).then((code) => {
    process.exitCode = code;
  });
}
