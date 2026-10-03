import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DATA_DB_BINDING, type DataSlot, otherSlot } from "@nonprofits/db";
import {
  readPointer,
  rebuildSearchIndex,
  refresh,
  rollback,
} from "./generation.ts";
import { irsSources, isSource, loadSource, type Source } from "./sources.ts";
import { type D1Ops, localD1, remoteD1 } from "./wrangler.ts";

/** What `all` loads, in order. Not efile: a full 990 run downloads ~10 GB and takes about an hour, so it is asked for by name. */
const ALL: readonly Source[] = ["bmf", "pub78", "revocation", "epostcard"];

const USAGE = `usage: node src/cli.ts <command>
  refresh [--remote] [--efile-batch <XML_BATCH_ID>]...
      build the data slot not served from every IRS source, verify it, seal it
      and serve it; --efile-batch (local only) loads just those e-file batches
  rollback [--remote]
      serve the other data slot again, while it still holds a complete build
  <bmf|pub78|revocation|epostcard|efile|all> [--slot a|b] [--force-active] [--batch <XML_BATCH_ID>]...
      dev, local only: load into a reset slot (default: the one not served),
      then rebuild its search index; all = ${ALL.join(", ")}
      --force-active  allow --slot to name the served slot
      --batch         efile only: load just the filings in this batch`;

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
        remote: { type: "boolean", default: false },
        batch: { type: "string", multiple: true },
        "efile-batch": { type: "string", multiple: true },
        slot: { type: "string" },
        "force-active": { type: "boolean", default: false },
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

async function main(): Promise<void> {
  const { values, positionals } = args();
  const [command, ...rest] = positionals;
  if (command === undefined || rest.length > 0) throw new UsageError();
  const sourceFlags =
    values.slot !== undefined ||
    values["force-active"] ||
    values.batch !== undefined;
  const ops: D1Ops = values.remote ? remoteD1() : localD1();
  const where = values.remote ? "remote" : "local";

  if (command === "refresh") {
    const batches = values["efile-batch"];
    if (sourceFlags || (batches !== undefined && values.remote)) {
      throw new UsageError();
    }
    console.log(`refresh: ${where} D1`);
    const report = await refresh(ops, {
      sources: irsSources({
        workDir: EFILE_WORK_DIR,
        ...(batches === undefined ? {} : { batches }),
      }),
      loadDir: LOAD_DIR,
      log: (line) => console.log(line),
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
    if (sourceFlags || values["efile-batch"] !== undefined) {
      throw new UsageError();
    }
    const { from, to, buildId } = await rollback(ops);
    console.log(
      `rollback: ${where} D1 serving slot ${to} (build ${buildId}) instead of slot ${from}`,
    );
    return;
  }

  const slot = values.slot;
  const sources =
    command === "all" ? ALL : isSource(command) ? [command] : undefined;
  if (
    sources === undefined ||
    values["efile-batch"] !== undefined ||
    (values.batch !== undefined && command !== "efile") ||
    (slot !== undefined && !isSlot(slot))
  ) {
    throw new UsageError();
  }
  if (values.remote) {
    throw new UsageError(
      "a single-source load is local only: remote data changes go through irs refresh",
    );
  }
  await loadSources(ops, sources, slot, values["force-active"], values.batch);
}

function isSlot(name: string): name is DataSlot {
  return name === "a" || name === "b";
}

/** Each source commits on its own, so one failing in `all` still lets the rest load. */
async function loadSources(
  ops: D1Ops,
  sources: readonly Source[],
  named: DataSlot | undefined,
  forceActive: boolean,
  batches: readonly string[] | undefined,
): Promise<void> {
  const { active } = await readPointer(ops);
  const slot = named ?? otherSlot(active);
  if (slot === active && !forceActive) {
    throw new UsageError(
      `slot ${slot} is the one served; pass --force-active to load into it`,
    );
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
  if (error instanceof UsageError) {
    if (error.message) console.error(error.message);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
