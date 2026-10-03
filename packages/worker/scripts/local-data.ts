// Local data slots for `wrangler dev`: `node scripts/local-data.ts <command> <a|b>`.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  DATA_DB_BINDING,
  type DataSlot,
  flipActiveSlotSql,
  READ_ACTIVE_SLOT_SQL,
  READ_DATA_META_SQL,
  rebuildSearchIndexSql,
  resetGenerationSql,
} from "@nonprofits/db";

const COMMANDS = ["reset", "seed", "search-index", "flip"] as const;
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

/** Points the local `data_generation` at `slot`, carrying that slot's build id. */
function flip(slot: DataSlot): void {
  const [meta] = query<{ build_id: string }>(
    DATA_DB_BINDING[slot],
    READ_DATA_META_SQL,
  );
  const [pointer] = query<{ active: DataSlot }>("APP_DB", READ_ACTIVE_SLOT_SQL);
  if (meta === undefined || pointer === undefined) {
    throw new Error(`slot ${slot} or the pointer has no row`);
  }
  if (pointer.active === slot) {
    console.log(`already serving slot ${slot}`);
    return;
  }
  const flipped = query(
    "APP_DB",
    flipActiveSlotSql(
      pointer.active,
      slot,
      meta.build_id,
      new Date().toISOString(),
    ),
  );
  if (flipped.length === 0)
    throw new Error("the pointer moved during the flip");
  console.log(`serving slot ${slot} (build ${meta.build_id})`);
}

function run(command: Command, slot: DataSlot): void {
  const binding = DATA_DB_BINDING[slot];
  switch (command) {
    case "reset":
      executeSql(
        binding,
        `reset-${slot}`,
        resetGenerationSql(slot, `local-${new Date().toISOString()}`),
      );
      return;
    case "seed":
      executeFile(binding, "fixtures/seed.sql");
      return;
    case "search-index":
      executeSql(binding, `search-index-${slot}`, rebuildSearchIndexSql(""));
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
run(command as Command, slot);
