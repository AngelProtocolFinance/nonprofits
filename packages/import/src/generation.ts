import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  claimSlotSql,
  DATA_DB_BINDING,
  type DataDbBinding,
  type DataSlot,
  flipActiveSlotSql,
  otherSlot,
  READ_ACTIVE_SLOT_SQL,
  READ_DATA_META_SQL,
  rebuildSearchIndexSql,
  releaseClaimSql,
  resetGenerationSql,
  sealGenerationSql,
} from "@nonprofits/db";
import { loadSource, SOURCES, type SourceConfig } from "./sources.ts";
import type { D1Ops } from "./wrangler.ts";

/** A new generation's row counts may differ from the served one's by this share and still flip. */
const COUNT_TOLERANCE = 0.1;
const COUNTED_TABLES = ["orgs", "filings", "programs"] as const;
type CountedTable = (typeof COUNTED_TABLES)[number];
/**
 * How long after a flip the slot it left may still be served: each Worker
 * isolate caches the pointer for `POINTER_TTL_MS` (30 s) in
 * packages/worker/src/data-db.ts. A refresh resets that slot only after this.
 */
const FLIP_SETTLE_MS = 60_000;
/** The org every generation must hold with a mission. */
const RED_CROSS = "530196605";

export interface RefreshOptions {
  sources: SourceConfig;
  /** Where the reset, load and search-index SQL files are written. */
  loadDir: string;
  /** Receives one line per step as the run goes. */
  log?: (line: string) => void;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RefreshReport {
  buildId: string;
  /** The slot built and now served. */
  slot: DataSlot;
  /** The slot served before, still complete: what `rollback` flips back to. */
  previous: DataSlot;
  counts: Record<CountedTable, number>;
  checks: Check[];
}

/** `APP_DB`'s `data_generation` row: the slot served and the build in it. */
export interface Pointer {
  active: DataSlot;
  build_id: string;
}

/** A data database's `data_meta` row. */
interface DataMeta {
  slot: DataSlot;
  build_id: string;
  state: "building" | "complete";
}

export async function readPointer(ops: D1Ops): Promise<Pointer> {
  const [pointer] = await ops.query<Pointer>("APP_DB", READ_ACTIVE_SLOT_SQL);
  if (pointer === undefined) {
    throw new Error(
      "APP_DB has no data_generation row; apply the app migrations first",
    );
  }
  return pointer;
}

/** Null for a database never reset into a generation. */
async function readMeta(
  ops: D1Ops,
  binding: DataDbBinding,
): Promise<DataMeta | null> {
  const tables = await ops.query(
    binding,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'data_meta'",
  );
  if (tables.length === 0) return null;
  const [meta] = await ops.query<DataMeta>(binding, READ_DATA_META_SQL);
  return meta ?? null;
}

/**
 * Builds a new generation from scratch in the slot the Worker isn't serving,
 * then points the Worker at it: claim → reset → every source in order → one
 * search index rebuild → verify → seal → flip. Any failure releases the claim
 * and throws, with the pointer unchanged and the slot left as the failure
 * found it (`building`, after a reset) for inspection.
 */
export async function refresh(
  ops: D1Ops,
  { sources, loadDir, log = () => {} }: RefreshOptions,
): Promise<RefreshReport> {
  const pointer = await readPointer(ops);
  const previous = pointer.active;
  const slot = otherSlot(previous);
  const binding = DATA_DB_BINDING[slot];
  // the start time, so a failed build's id says where Time Travel restores to
  const buildId = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const claimed = await ops.query(
    "APP_DB",
    claimSlotSql(slot, buildId, new Date().toISOString()),
  );
  if (claimed.length !== 1) {
    throw new Error(
      `refresh refused: slot ${slot} is served, or another build holds its claim`,
    );
  }
  log(
    `claimed slot ${slot} (${binding}) for build ${buildId}; serving slot ${previous} (build ${pointer.build_id})`,
  );
  try {
    const report = await build(ops, {
      pointer,
      slot,
      buildId,
      loadDir,
      sources,
      log,
    });
    const flipped = await ops.query(
      "APP_DB",
      flipActiveSlotSql(previous, buildId, new Date().toISOString()),
    );
    if (flipped.length !== 1) {
      throw new Error(
        `flip refused: the pointer moved off slot ${previous} or build ${buildId} lost its claim during the run`,
      );
    }
    log(`flipped: serving slot ${slot} (build ${buildId})`);
    return report;
  } catch (error) {
    await ops.query("APP_DB", releaseClaimSql(buildId)).catch(() => {
      log(
        `could not release build ${buildId}'s claim; it lapses with its lease`,
      );
    });
    throw error;
  }
}

/** Everything up to the flip: reset, loads, search index, verify, seal. */
async function build(
  ops: D1Ops,
  {
    pointer,
    slot,
    buildId,
    loadDir,
    sources,
    log,
  }: {
    pointer: Pointer;
    slot: DataSlot;
    buildId: string;
    loadDir: string;
    sources: SourceConfig;
    log: (line: string) => void;
  },
): Promise<RefreshReport> {
  const binding = DATA_DB_BINDING[slot];
  const found = await readMeta(ops, binding);
  if (found !== null && found.slot !== slot) {
    throw new Error(
      `refresh refused: ${binding} holds slot ${found.slot}'s generation, so it may be the database served; check the database_id each binding names`,
    );
  }
  await settleLastFlip(ops, slot, log);
  await mkdir(loadDir, { recursive: true });
  await timed(log, `reset ${binding}`, () =>
    applySql(
      ops,
      binding,
      join(loadDir, `reset-${slot}.sql`),
      resetGenerationSql(slot, buildId),
    ),
  );
  for (const source of SOURCES) {
    await timed(log, `loaded ${source}`, async () => {
      const out = join(loadDir, `${source}.load.sql`);
      const lines = await loadSource(source, sources, { ops, binding }, out);
      for (const line of lines) log(`  ${line}`);
    });
  }
  await timed(log, "rebuilt the search index", () =>
    rebuildSearchIndex(ops, binding, loadDir),
  );

  const { counts, checks } = await verify(ops, pointer, slot, buildId);
  for (const check of checks) {
    log(`check ${check.name}: ${check.ok ? "ok" : "FAILED"}, ${check.detail}`);
  }
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    throw new Error(
      `verify failed for build ${buildId} in ${binding}: ${failed.map((c) => `${c.name} (${c.detail})`).join("; ")}`,
    );
  }

  const [sealed] = await ops.query<DataMeta>(
    binding,
    sealGenerationSql(buildId),
  );
  if (
    sealed?.slot !== slot ||
    sealed.build_id !== buildId ||
    sealed.state !== "complete"
  ) {
    throw new Error(`could not seal build ${buildId} in ${binding}`);
  }
  log(`sealed build ${buildId} in ${binding}`);
  return { buildId, slot, previous: pointer.active, counts, checks };
}

/** Waits until no Worker isolate can still be serving `slot` from before the last flip. */
async function settleLastFlip(
  ops: D1Ops,
  slot: DataSlot,
  log: (line: string) => void,
): Promise<void> {
  const [last] = await ops.query<{ flipped_at: string }>(
    "APP_DB",
    "SELECT flipped_at FROM data_generation WHERE id = 1",
  );
  const wait = Date.parse(last?.flipped_at ?? "") + FLIP_SETTLE_MS - Date.now();
  if (!(wait > 0)) return;
  log(
    `waiting ${Math.ceil(wait / 1000)} s: the flip at ${last?.flipped_at} left slot ${slot}, and Workers may still serve it`,
  );
  await new Promise((resolve) => setTimeout(resolve, wait));
}

type Stats = Record<CountedTable, number> & {
  named_orgs: number;
  index_rows: number;
  null_eins: number;
  red_cross_mission: string | null;
};

async function verify(
  ops: D1Ops,
  pointer: Pointer,
  slot: DataSlot,
  buildId: string,
): Promise<{ counts: Record<CountedTable, number>; checks: Check[] }> {
  const binding = DATA_DB_BINDING[slot];
  const meta = await readMeta(ops, binding);
  const [stats] = await ops.query<Stats>(
    binding,
    `SELECT ${countColumns()},
  (SELECT count(*) FROM orgs WHERE name IS NOT NULL) AS named_orgs,
  (SELECT count(*) FROM orgs_fts) AS index_rows,
  (SELECT count(*) FROM orgs WHERE ein IS NULL) + (SELECT count(*) FROM filings WHERE ein IS NULL) + (SELECT count(*) FROM programs WHERE ein IS NULL) AS null_eins,
  (SELECT f.mission FROM orgs o JOIN filings f ON f.ein = o.ein WHERE o.ein = '${RED_CROSS}') AS red_cross_mission`,
  );
  if (stats === undefined) throw new Error(`${binding} returned no counts`);
  const counts = Object.fromEntries(
    COUNTED_TABLES.map((table) => [table, stats[table]]),
  ) as Record<CountedTable, number>;
  const checks: Check[] = [
    {
      name: "slot",
      ok:
        meta?.slot === slot &&
        meta.build_id === buildId &&
        meta.state === "building",
      detail:
        meta === null
          ? `${binding} has no data_meta`
          : `${binding} says slot ${meta.slot}, build ${meta.build_id}, ${meta.state}`,
    },
    ...(await countChecks(ops, pointer, counts)),
    {
      name: "red cross",
      ok: Boolean(stats.red_cross_mission?.trim()),
      detail: stats.red_cross_mission
        ? `${RED_CROSS} has its mission`
        : `${RED_CROSS} has no filing with a mission`,
    },
    {
      name: "search index",
      ok: stats.index_rows === stats.named_orgs,
      detail: `${stats.index_rows} index rows, ${stats.named_orgs} named orgs`,
    },
    {
      name: "null eins",
      ok: stats.null_eins === 0,
      detail: `${stats.null_eins} rows without an EIN`,
    },
  ];
  return { counts, checks };
}

function countColumns(): string {
  return COUNTED_TABLES.map((t) => `(SELECT count(*) FROM ${t}) AS ${t}`).join(
    ", ",
  );
}

/** Each table's count against the served generation's; nothing to compare on the first build. */
async function countChecks(
  ops: D1Ops,
  pointer: Pointer,
  counts: Record<CountedTable, number>,
): Promise<Check[]> {
  if (pointer.build_id === "empty") {
    return [
      {
        name: "counts",
        ok: true,
        detail: "first build, none served to compare",
      },
    ];
  }
  const [served] = await ops.query<Record<CountedTable, number>>(
    DATA_DB_BINDING[pointer.active],
    `SELECT ${countColumns()}`,
  );
  if (served === undefined) {
    throw new Error("the served generation returned no counts");
  }
  return COUNTED_TABLES.map((table) => ({
    name: `${table} count`,
    ok:
      Math.abs(counts[table] - served[table]) <=
      COUNT_TOLERANCE * served[table],
    detail: `${table}: ${counts[table]}, served ${served[table]}`,
  }));
}

/** Indexes every named org in `binding`'s generation, replacing what its search index held. */
export function rebuildSearchIndex(
  ops: D1Ops,
  binding: DataDbBinding,
  loadDir: string,
): Promise<void> {
  return applySql(
    ops,
    binding,
    join(loadDir, "search-index.sql"),
    rebuildSearchIndexSql(""),
  );
}

async function applySql(
  ops: D1Ops,
  binding: DataDbBinding,
  file: string,
  sql: string,
): Promise<void> {
  await writeFile(file, sql);
  await ops.applyFile(binding, file);
}

/** Runs `step`, then logs `done` with how long it took. */
async function timed(
  log: (line: string) => void,
  done: string,
  step: () => Promise<void>,
): Promise<void> {
  const started = performance.now();
  await step();
  log(`${done} (${((performance.now() - started) / 1000).toFixed(1)} s)`);
}

/**
 * Points the Worker back at the other slot, if it still holds a complete
 * generation (no refresh has reset it since). Otherwise throws with the D1
 * Time Travel restore that brings that slot's generation back.
 */
export async function rollback(
  ops: D1Ops,
): Promise<{ from: DataSlot; to: DataSlot; buildId: string }> {
  const { active: from } = await readPointer(ops);
  const to = otherSlot(from);
  const binding = DATA_DB_BINDING[to];
  const meta = await readMeta(ops, binding);
  if (meta?.slot !== to || meta.state !== "complete") {
    throw new Error(nothingToRollBackTo(binding, to, meta));
  }
  const at = new Date().toISOString();
  const claimed = await ops.query(
    "APP_DB",
    claimSlotSql(to, meta.build_id, at),
  );
  if (claimed.length !== 1) {
    throw new Error(
      `rollback refused: a build holds slot ${to}'s claim; wait for it to finish or its lease to run out`,
    );
  }
  const flipped = await ops.query(
    "APP_DB",
    flipActiveSlotSql(from, meta.build_id, at),
  );
  if (flipped.length !== 1) {
    await ops.query("APP_DB", releaseClaimSql(meta.build_id));
    throw new Error(`rollback refused: the pointer moved off slot ${from}`);
  }
  return { from, to, buildId: meta.build_id };
}

function nothingToRollBackTo(
  binding: DataDbBinding,
  slot: DataSlot,
  meta: DataMeta | null,
): string {
  const why =
    meta === null
      ? "it holds no generation"
      : meta.slot !== slot
        ? `it holds slot ${meta.slot}'s generation`
        : `its build ${meta.build_id} never completed`;
  // a refresh's build id is when it started, just before it reset the slot
  const before =
    meta?.state === "building" && !Number.isNaN(Date.parse(meta.build_id))
      ? meta.build_id
      : "<RFC3339 time before its last reset>";
  return `rollback refused: slot ${slot} (${binding}) has no complete generation to serve: ${why}.
Restore it with D1 Time Travel (remote only; \`wrangler d1 time-travel info\` lists bookmarks), then run irs rollback again:
  wrangler d1 time-travel restore ${binding} --timestamp=${before} --config packages/worker/wrangler.jsonc`;
}
