import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  DATA_DB_BINDING,
  type DataSlot,
  otherSlot,
  releaseClaimSql,
} from "@nonprofits/db";
import {
  readPointer,
  rebuildSearchIndex,
  refresh,
  releaseClaim,
  rollback,
  TABLE_FLOORS,
} from "./generation.ts";
import {
  irsSources,
  isSource,
  loadSource,
  SOURCES,
  type Source,
} from "./sources.ts";
import { type D1Ops, localD1, remoteD1, stopWrangler } from "./wrangler.ts";

/** What `all` loads, in order. Not efile: a full 990 run downloads ~10 GB and takes about an hour, so it is asked for by name. */
const ALL = SOURCES.filter((source) => source !== "efile");

const USAGE = `usage: node src/cli.ts <command>
  refresh [--remote] [--efile-batch <XML_BATCH_ID>]...
      build the data slot not served from every IRS source, verify it, seal it
      and serve it; --efile-batch (local only) loads just those e-file batches
  rollback [--remote]
      serve the other data slot again, while it holds a complete build that was served before
  release [--remote] [--build <BUILD_ID>]
      clear the claim a stopped build left on the slot not served (only that build's, with --build)
  <bmf|pub78|revocation|epostcard|efile|all> [--slot a|b] [--batch <XML_BATCH_ID>]...
      dev, local only: load into a slot reset for it (default: the one not served),
      then rebuild its search index; all = ${ALL.join(", ")}
      --batch  efile only: load just the filings in this batch
  --persist-to <dir>  local D1 state under <dir> instead of wrangler's default`;

/** The flags each command takes, beside --persist-to. */
const FLAGS = {
  refresh: ["remote", "efile-batch"],
  rollback: ["remote"],
  release: ["remote", "build"],
  load: ["slot", "batch"],
} as const;

function repoPath(path: string): string {
  return fileURLToPath(new URL(`../../../${path}`, import.meta.url));
}

const LOAD_DIR = repoPath("load");
const EFILE_WORK_DIR = repoPath("data/efile");

class UsageError extends Error {}

function args() {
  try {
    return parseArgs({
      options: {
        remote: { type: "boolean" },
        "persist-to": { type: "string" },
        batch: { type: "string", multiple: true },
        "efile-batch": { type: "string", multiple: true },
        slot: { type: "string" },
        build: { type: "string" },
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

/** Set by a SIGINT or SIGTERM, so the run's own failure isn't reported over it. */
let interrupted = false;

async function main(): Promise<void> {
  const { values, positionals } = args();
  const [command, ...rest] = positionals;
  if (command === undefined || rest.length > 0) throw new UsageError();
  const flags =
    command === "refresh" || command === "rollback" || command === "release"
      ? FLAGS[command]
      : FLAGS.load;
  const given = Object.entries(values)
    .filter(([name, value]) => value !== undefined && name !== "persist-to")
    .map(([name]) => name);
  const unexpected = given.filter(
    (name) => !(flags as readonly string[]).includes(name),
  );
  if (unexpected.length > 0) {
    throw new UsageError(`${command} takes no --${unexpected.join(", --")}`);
  }
  const remote = values.remote === true;
  if (remote && values["persist-to"] !== undefined) {
    throw new UsageError("--persist-to is for local D1 state only");
  }
  const ops: D1Ops = remote ? remoteD1() : localD1(values["persist-to"]);
  const where = remote ? "remote" : "local";

  if (command === "refresh") {
    const batches = values["efile-batch"];
    const claims = releaseOnSignal(ops);
    console.log(`refresh: ${where} D1`);
    const report = await refresh(ops, {
      sources: irsSources({
        workDir: EFILE_WORK_DIR,
        ...(batches === undefined ? {} : { batches }),
      }),
      floors: TABLE_FLOORS,
      loadDir: LOAD_DIR,
      log,
      onClaim: (buildId) => claims.push(buildId),
    });
    const counts = Object.entries(report.counts)
      .map(([table, n]) => `${n} ${table}`)
      .join(", ");
    console.log(
      `refresh: serving slot ${report.slot}, build ${report.buildId} (${counts}); irs rollback serves slot ${report.previous} again`,
    );
    return;
  }

  if (command === "rollback") {
    const claims = releaseOnSignal(ops);
    const { from, to, buildId } = await rollback(ops, {
      log,
      onClaim: (buildId) => claims.push(buildId),
    });
    console.log(
      `rollback: ${where} D1 serving slot ${to} (build ${buildId}) instead of slot ${from}`,
    );
    return;
  }

  if (command === "release") {
    const claim = await releaseClaim(ops, values.build);
    if (claim === null) {
      console.log(
        values.build === undefined
          ? `release: ${where} D1 has no claim to release`
          : `release: build ${values.build} holds no claim in ${where} D1`,
      );
      if (values.build !== undefined) process.exitCode = 1;
      return;
    }
    console.log(
      `release: cleared build ${claim.claim_build_id}'s claim on slot ${claim.claim_slot} (claimed ${claim.claimed_at}, lease to ${claim.claim_expires_at})`,
    );
    return;
  }

  const sources =
    command === "all" ? ALL : isSource(command) ? [command] : undefined;
  const slot = values.slot;
  if (
    sources === undefined ||
    (values.batch !== undefined && command !== "efile") ||
    (slot !== undefined && !isSlot(slot))
  ) {
    throw new UsageError();
  }
  if (remote) {
    throw new UsageError(
      "a single-source load is local only: remote data changes go through irs refresh",
    );
  }
  await loadSources(ops, sources, slot, values.batch);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The run's own lines; quiet once a signal is stopping it, as its failures are the stop's. */
function log(line: string): void {
  if (!interrupted) console.log(line);
}

function isSlot(name: string): name is DataSlot {
  return name === "a" || name === "b";
}

/**
 * On SIGINT or SIGTERM: stops wrangler (the running command and every later
 * one the run starts), releases every claim the run asked for (a claim it
 * never got releases nothing), reports what the pointer serves, and exits 130
 * or 143. Returns the list the run adds each build id to as it claims.
 */
function releaseOnSignal(ops: D1Ops): string[] {
  const claims: string[] = [];
  const stop = async (signal: NodeJS.Signals, code: number) => {
    interrupted = true;
    console.error(`${signal}: stopping`);
    await stopWrangler(async () => {
      for (const buildId of claims) {
        try {
          const released = await ops.query("APP_DB", releaseClaimSql(buildId));
          console.error(
            released.length === 1
              ? `released build ${buildId}'s claim`
              : `build ${buildId} holds no claim`,
          );
        } catch (error) {
          console.error(
            `could not release build ${buildId}'s claim (${message(error)}); irs release --build ${buildId} clears it`,
          );
        }
      }
      try {
        const pointer = await readPointer(ops);
        console.error(
          `serving slot ${pointer.active} (build ${pointer.build_id})`,
        );
      } catch (error) {
        console.error(`could not read the pointer back (${message(error)})`);
      }
    });
    process.exit(code);
  };
  process.once("SIGINT", (signal) => void stop(signal, 130));
  process.once("SIGTERM", (signal) => void stop(signal, 143));
  return claims;
}

/** Each source commits on its own, so one failing in `all` still lets the rest load. */
async function loadSources(
  ops: D1Ops,
  sources: readonly Source[],
  named: DataSlot | undefined,
  batches: readonly string[] | undefined,
): Promise<void> {
  const { active } = await readPointer(ops);
  const slot = named ?? otherSlot(active);
  if (slot === active) {
    throw new UsageError(`slot ${slot} is the one served`);
  }
  const binding = DATA_DB_BINDING[slot];
  const config = irsSources({
    workDir: EFILE_WORK_DIR,
    ...(batches === undefined ? {} : { batches }),
  });
  const failed: Source[] = [];
  for (const source of sources) {
    const out = join(LOAD_DIR, `${source}.load.sql`);
    console.error(`importing ${source} into local ${binding} via ${out}`);
    try {
      for (const line of await loadSource(
        source,
        config,
        { ops, binding },
        out,
      )) {
        console.log(line);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      failed.push(source);
    }
  }
  if (failed.length < sources.length) {
    await rebuildSearchIndex(ops, binding, LOAD_DIR);
    console.log(`rebuilt ${binding}'s search index`);
  }
  if (failed.length > 0) {
    console.error(`not imported: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  if (interrupted) return;
  if (error instanceof UsageError) {
    if (error.message) console.error(error.message);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
