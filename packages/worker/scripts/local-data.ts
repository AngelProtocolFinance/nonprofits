// Local data slots for `wrangler dev`: `node scripts/local-data.ts <command> <a|b>`.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  claimSlotSql,
  DATA_DB_BINDING,
  type DataSlot,
  flipActiveSlotSql,
  READ_DATA_META_SQL,
  rebuildSearchIndexSql,
  releaseClaimSql,
  resetGenerationSql,
  sealGenerationSql,
} from "@nonprofits/db";

const COMMANDS = ["reset", "seed", "search-index", "seal", "flip"] as const;
type Command = (typeof COMMANDS)[number];

function wrangler(args: string[]): string {
  return execFileSync("wrangler", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function executeFile(binding: string, file: string): void {
  wrangler(["d1", "execute", binding, "--local", "--file", file]);
}

function executeSql(binding: string, name: string, sql: string): void {
  mkdirSync(".wrangler", { recursive: true });
  const file = `.wrangler/${name}.sql`;
  writeFileSync(file, sql);
  executeFile(binding, file);
}

function query<T>(binding: string, sql: string): T[] {
  const out = wrangler([
    "d1",
    "execute",
    binding,
    "--local",
    "--json",
    "--command",
    sql,
  ]);
  return (JSON.parse(out) as { results: T[] }[]).at(-1)?.results ?? [];
}

interface Pointer {
  active: DataSlot;
  claim_slot: DataSlot | null;
  claim_build_id: string | null;
}

function pointer(): Pointer {
  const [row] = query<Pointer>(
    "APP_DB",
    "SELECT active, claim_slot, claim_build_id FROM data_generation WHERE id = 1",
  );
  if (row === undefined) throw new Error("data_generation has no row");
  return row;
}

function meta(slot: DataSlot): { build_id: string; state: string } {
  const [row] = query<{ build_id: string; state: string }>(
    DATA_DB_BINDING[slot],
    READ_DATA_META_SQL,
  );
  if (row === undefined) throw new Error(`slot ${slot} has no data_meta row`);
  return row;
}

/**
 * Claims `slot` for a new local build, then resets it. Locally one developer
 * builds at a time, so a claim left on `slot` by an earlier local build is
 * released rather than waited out.
 */
function reset(slot: DataSlot): void {
  const buildId = `local-${new Date().toISOString()}`;
  const { claim_slot, claim_build_id } = pointer();
  if (claim_slot === slot && claim_build_id !== null) {
    query("APP_DB", releaseClaimSql(claim_build_id));
    console.log(`released the earlier claim of build ${claim_build_id}`);
  }
  const claimed = query(
    "APP_DB",
    claimSlotSql(slot, buildId, new Date().toISOString()),
  );
  if (claimed.length === 0) {
    throw new Error(`slot ${slot} is the one being served: reset the other`);
  }
  executeSql(
    DATA_DB_BINDING[slot],
    `reset-${slot}`,
    resetGenerationSql(slot, buildId),
  );
  console.log(`slot ${slot} reset for build ${buildId}`);
}

function seal(slot: DataSlot): void {
  const { build_id } = meta(slot);
  if (query(DATA_DB_BINDING[slot], sealGenerationSql(build_id)).length === 0) {
    throw new Error(`slot ${slot} is already sealed`);
  }
  console.log(`slot ${slot} sealed (build ${build_id})`);
}

/**
 * Points the local `data_generation` at `slot` once it is sealed. A slot whose
 * build holds no claim (a rollback to the generation still intact there) is
 * claimed for that build first.
 */
function flip(slot: DataSlot): void {
  const { build_id, state } = meta(slot);
  if (state !== "complete") {
    throw new Error(
      `slot ${slot} isn't sealed, so the Worker won't serve it: pnpm db:seal:local ${slot}`,
    );
  }
  const { active, claim_build_id } = pointer();
  if (active === slot) {
    console.log(`already serving slot ${slot}`);
    return;
  }
  if (
    claim_build_id !== build_id &&
    query("APP_DB", claimSlotSql(slot, build_id, new Date().toISOString()))
      .length === 0
  ) {
    throw new Error(`build ${claim_build_id} holds slot ${slot}`);
  }
  const flipped = query(
    "APP_DB",
    flipActiveSlotSql(active, build_id, new Date().toISOString()),
  );
  if (flipped.length === 0)
    throw new Error("the pointer moved during the flip");
  console.log(`serving slot ${slot} (build ${build_id})`);
}

function run(command: Command, slot: DataSlot): void {
  const binding = DATA_DB_BINDING[slot];
  switch (command) {
    case "reset":
      reset(slot);
      return;
    case "seed":
      executeFile(binding, "fixtures/seed.sql");
      return;
    case "search-index":
      executeSql(binding, `search-index-${slot}`, rebuildSearchIndexSql(""));
      return;
    case "seal":
      seal(slot);
      return;
    case "flip":
      flip(slot);
      return;
  }
}

const [command, slot] = process.argv.slice(2);
if (!COMMANDS.includes(command as Command) || (slot !== "a" && slot !== "b")) {
  console.error(`usage: local-data.ts <${COMMANDS.join("|")}> <a|b>`);
  process.exit(2);
}
try {
  run(command as Command, slot);
} catch (error) {
  // wrangler already printed its own failure to stderr
  console.error((error as Error).message);
  process.exit(1);
}
