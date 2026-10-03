import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Claim,
  claimSlotSql,
  DATA_DB_BINDING,
  type DataDbBinding,
  type DataMeta,
  type DataSlot,
  FLIP_SETTLE_MS,
  fenceSql,
  flipActiveSlotSql,
  NEVER_BUILT,
  otherSlot,
  type Pointer,
  READ_ACTIVE_SLOT_SQL,
  READ_CLAIM_SQL,
  rebuildSearchIndexSql,
  releaseClaimSql,
  resetGenerationSql,
  sealGenerationSql,
} from "@nonprofits/db";
import { loadSource, SOURCES, type SourceConfig } from "./sources.ts";
import { type D1Ops, type D1Target, ImportMayBeRunning } from "./wrangler.ts";

/** A new generation's row counts may differ from the served one's by this share and still flip. */
const COUNT_TOLERANCE = 0.1;
/** What verify counts, each the rows `count(*)` reads: every table's, and the orgs each list fact landed on. */
const COUNTED = {
  orgs: "orgs",
  filings: "filings",
  programs: "programs",
  in_pub78: "orgs WHERE in_pub78 = 1",
  revocation_date: "orgs WHERE revocation_date IS NOT NULL",
  files_990n: "orgs WHERE files_990n = 1",
  bmf_run_id: "orgs WHERE bmf_run_id IS NOT NULL",
} as const;
type Counted = keyof typeof COUNTED;

/** The fewest of each count a generation may hold: all a first build, with no served counts to compare, is held to besides its other checks. */
export type TableFloors = Record<Counted, number>;

export const TABLE_FLOORS: TableFloors = {
  // 90% of the 3,275,963 orgs of the 2026-10-03 local build (Sep 2026 BMF and lists)
  orgs: 2_948_000,
  // 90% of the 760,592 latest filings a full run selects from the 2024–2026 indexes of 2026-10-03
  filings: 684_000,
  // 80% of ~939,500: 1.50 programs per 990 and 990-EZ filing in batch 2026_TEOS_XML_03A
  // (57,624 for 38,404) times the 626,151 a full run selects; an extrapolation, hence the wider margin
  programs: 750_000,
  // 90% of the 2026-10-03 local build's 1,419,989 orgs in Pub 78 (Sep 2026 list)
  in_pub78: 1_277_000,
  // 90% of its 1,227,606 orgs with a revocation date (Sep 2026 list)
  revocation_date: 1_104_000,
  // 90% of its 1,546,723 990-N filers (Sep 2026 e-Postcard list)
  files_990n: 1_392_000,
  // 90% of its 1,964,958 orgs from the Sep 2026 BMF
  bmf_run_id: 1_768_000,
};

/** The org every generation must hold with a mission. */
const RED_CROSS = "530196605";

export interface RefreshOptions {
  sources: SourceConfig;
  floors: TableFloors;
  /** Where the reset, load and search-index SQL files are written. */
  loadDir: string;
  /** Receives one line per step as the run goes. */
  log?: (line: string) => void;
  /** Called with the build's id just before its claim is sent, so whoever stops the run can release it. */
  onClaim?: (buildId: string) => void;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  seconds: number;
}

export interface RefreshReport {
  buildId: string;
  /** The slot built and now served. */
  slot: DataSlot;
  /** The slot served before, still complete: what `rollback` flips back to. */
  previous: DataSlot;
  counts: Record<Counted, number>;
  checks: Check[];
}

/** A data database's whole `data_meta` row: `DataMeta` and when it was sealed. */
interface DataMetaRow extends DataMeta {
  built_at: string | null;
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
export async function readMeta(
  ops: D1Ops,
  binding: DataDbBinding,
): Promise<DataMetaRow | null> {
  const tables = await ops.query(
    binding,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'data_meta'",
  );
  if (tables.length === 0) return null;
  const [meta] = await ops.query<DataMetaRow>(
    binding,
    "SELECT slot, build_id, state, built_at FROM data_meta WHERE id = 1",
  );
  return meta ?? null;
}

/**
 * Builds a new generation from scratch in the slot the Worker isn't serving,
 * then points the Worker at it: claim → reset → every source in order → one
 * search index rebuild → verify → seal → flip. Every file applied to the
 * slot opens with the build's fence. Any failure releases the claim and
 * throws with the pointer unchanged; an `ImportMayBeRunning` keeps the claim
 * instead, logging the release to run once that import has ended. The slot
 * stays as the failure left it, for inspection until the next refresh resets
 * it: `building` when the run stopped before the seal, sealed `complete` but
 * never served when the flip failed (rollback won't serve such a build).
 *
 * `sources.efile.batches` builds a partial generation, local only; it passes
 * verify only against a served build made from the same batches.
 */
export async function refresh(
  ops: D1Ops,
  { sources, floors, loadDir, log = () => {}, onClaim }: RefreshOptions,
): Promise<RefreshReport> {
  const partialEfile = sources.efile.batches !== undefined;
  if (ops.remote && partialEfile) {
    throw new Error(
      "refresh refused: an e-file batch run builds a partial generation, which is local only",
    );
  }
  const pointer = await readPointer(ops);
  const previous = pointer.active;
  const slot = otherSlot(previous);
  const binding = DATA_DB_BINDING[slot];
  await settleLastFlip(pointer, slot, log);
  // the start time, so a failed build's id says where Time Travel restores to
  const buildId = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  onClaim?.(buildId);
  try {
    const claimed = await ops.query("APP_DB", claimSlotSql(slot, buildId));
    if (claimed.length !== 1) {
      throw new Error(
        `refresh refused: slot ${slot} is served, another build holds its claim, or the pointer moved under ${FLIP_SETTLE_MS / 1000} s ago`,
      );
    }
    log(
      `claimed slot ${slot} (${binding}) for build ${buildId}; serving slot ${previous} (build ${pointer.build_id})`,
    );
    const report = await build(ops, {
      pointer,
      slot,
      buildId,
      loadDir,
      sources,
      floors: partialEfile ? { ...floors, filings: 0, programs: 0 } : floors,
      log,
    });
    await flip(ops, previous, buildId, log);
    return report;
  } catch (error) {
    if (error instanceof ImportMayBeRunning) {
      log(keepsClaim(buildId, error.binding));
    } else {
      await releaseFailedClaim(ops, buildId, log);
    }
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
    floors,
    log,
  }: {
    pointer: Pointer;
    slot: DataSlot;
    buildId: string;
    loadDir: string;
    sources: SourceConfig;
    floors: TableFloors;
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
      const lines = await loadSource(
        source,
        sources,
        { ops, binding, buildId },
        out,
      );
      for (const line of lines) log(`  ${line}`);
    });
  }
  await timed(log, "rebuilt the search index", () =>
    rebuildSearchIndex({ ops, binding, buildId }, loadDir),
  );

  const { counts, checks } = await verify(ops, {
    pointer,
    slot,
    buildId,
    floors,
    log,
  });
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

/** Waits until no Worker isolate can still be serving `slot` from before the pointer's last flip. */
async function settleLastFlip(
  pointer: Pointer,
  slot: DataSlot,
  log: (line: string) => void,
): Promise<void> {
  const wait = Date.parse(pointer.flipped_at) + FLIP_SETTLE_MS - Date.now();
  if (!(wait > 0)) return;
  log(
    `waiting ${Math.ceil(wait / 1000)} s: the flip at ${pointer.flipped_at} left slot ${slot}, and Workers may still serve it`,
  );
  await new Promise((resolve) => setTimeout(resolve, wait));
}

/**
 * Points the Worker from `from` to the slot `buildId` claimed. A flip whose
 * answer is lost may still have landed, so any failure reads the pointer back
 * before reporting one.
 */
async function flip(
  ops: D1Ops,
  from: DataSlot,
  buildId: string,
  log: (line: string) => void,
): Promise<void> {
  const to = otherSlot(from);
  let failure: unknown;
  try {
    const flipped = await ops.query("APP_DB", flipActiveSlotSql(from, buildId));
    if (flipped.length === 1) {
      log(`flipped: serving slot ${to} (build ${buildId})`);
      return;
    }
  } catch (error) {
    failure = error;
  }
  const why =
    failure === undefined
      ? `flip refused: the pointer moved off slot ${from} or build ${buildId} lost its claim during the run`
      : `flip failed: ${message(failure)}`;
  let now: Pointer;
  try {
    now = await readPointer(ops);
  } catch (error) {
    throw new Error(
      `${why}; reading the pointer back failed too (${message(error)}), so whether slot ${to} is served is unknown: read data_generation before anything else`,
    );
  }
  if (now.active === to && now.build_id === buildId) {
    log(
      `flipped: serving slot ${to} (build ${buildId}); the flip's own answer was lost (${message(failure)})`,
    );
    return;
  }
  throw new Error(
    `${why}; the pointer serves slot ${now.active} (build ${now.build_id})`,
  );
}

/**
 * Why `buildId` keeps its claim after `binding`'s remote import was cut short:
 * the next build's reset would land in the middle of that import.
 */
function keepsClaim(buildId: string, binding: string): string {
  return `build ${buildId} keeps its claim: ${binding}'s import may still be running in D1, which serves that database no queries until it ends; once it has, irs release --remote --build ${buildId} clears the claim`;
}

/**
 * The cleanup after a stop killed the `killed` wrangler commands: releases
 * each of `buildIds`' claims, but keeps them all when a remote `--file` was
 * among the killed, then reports what the pointer serves.
 */
export async function releaseAfterStop(
  ops: D1Ops,
  buildIds: readonly string[],
  killed: readonly (readonly string[])[],
  report: (line: string) => void,
): Promise<void> {
  const remoteImport = ops.remote
    ? killed.find((args) => args.includes("--file"))
    : undefined;
  for (const buildId of buildIds) {
    if (remoteImport !== undefined) {
      // `d1 execute <binding> …`
      report(keepsClaim(buildId, remoteImport[2] ?? "the data database"));
      continue;
    }
    try {
      const released = await ops.query("APP_DB", releaseClaimSql(buildId));
      report(
        released.length === 1
          ? `released build ${buildId}'s claim`
          : `build ${buildId} holds no claim`,
      );
    } catch (error) {
      report(
        `could not release build ${buildId}'s claim (${message(error)}); ${releaseCommand(ops, buildId)} clears it`,
      );
    }
  }
  try {
    const pointer = await readPointer(ops);
    report(`serving slot ${pointer.active} (build ${pointer.build_id})`);
  } catch (error) {
    report(`could not read the pointer back (${message(error)})`);
  }
}

/** The `irs release` that clears `buildId`'s claim where `ops` runs. */
function releaseCommand(ops: D1Ops, buildId: string): string {
  return `irs release${ops.remote ? " --remote" : ""} --build ${buildId}`;
}

async function releaseFailedClaim(
  ops: D1Ops,
  buildId: string,
  log: (line: string) => void,
): Promise<void> {
  try {
    await ops.query("APP_DB", releaseClaimSql(buildId));
  } catch (error) {
    log(
      `could not release build ${buildId}'s claim (${message(error)}); ${releaseCommand(ops, buildId)} clears it, or it lapses with its lease`,
    );
  }
}

/**
 * Clears the claim on the slot not served: `buildId`'s only, when named.
 * Resolves with the claim cleared, or null when there was none to clear.
 * A build still running loses its flip, so clear only a dead build's claim.
 */
export async function releaseClaim(
  ops: D1Ops,
  buildId?: string,
): Promise<Claim | null> {
  const [claim] = await ops.query<Claim>("APP_DB", READ_CLAIM_SQL);
  const held = claim?.claim_build_id ?? null;
  if (held === null || (buildId !== undefined && held !== buildId)) {
    return null;
  }
  const released = await ops.query("APP_DB", releaseClaimSql(held));
  return released.length === 1 ? (claim ?? null) : null;
}

/** One query per check, so each stays under D1's per-query limit and its time shows in the log. */
async function verify(
  ops: D1Ops,
  {
    pointer,
    slot,
    buildId,
    floors,
    log,
  }: {
    pointer: Pointer;
    slot: DataSlot;
    buildId: string;
    floors: TableFloors;
    log: (line: string) => void;
  },
): Promise<{ counts: Record<Counted, number>; checks: Check[] }> {
  const binding = DATA_DB_BINDING[slot];
  const servedBinding = DATA_DB_BINDING[pointer.active];
  const firstBuild = pointer.build_id === NEVER_BUILT;
  const checks: Check[] = [];
  async function check(
    name: string,
    run: () => Promise<{ ok: boolean; detail: string }>,
  ): Promise<void> {
    const started = performance.now();
    const result = await run();
    const seconds = (performance.now() - started) / 1000;
    checks.push({ name, ...result, seconds });
    log(
      `check ${name}: ${result.ok ? "ok" : "FAILED"}, ${result.detail} (${seconds.toFixed(1)} s)`,
    );
  }
  const count = async (db: DataDbBinding, sql: string): Promise<number> => {
    const [row] = await ops.query<{ n: number }>(db, sql);
    if (row === undefined) throw new Error(`${db} returned no count`);
    return row.n;
  };

  await check("slot", async () => {
    const meta = await readMeta(ops, binding);
    return {
      ok:
        meta?.slot === slot &&
        meta.build_id === buildId &&
        meta.state === "building",
      detail:
        meta === null
          ? `${binding} has no data_meta`
          : `${binding} says slot ${meta.slot}, build ${meta.build_id}, ${meta.state}`,
    };
  });
  const counts = {} as Record<Counted, number>;
  for (const [name, rows] of Object.entries(COUNTED) as [Counted, string][]) {
    await check(`${name} floor`, async () => {
      counts[name] = await count(binding, `SELECT count(*) AS n FROM ${rows}`);
      return {
        ok: counts[name] >= floors[name],
        detail: `${name}: ${counts[name]}, floor ${floors[name]}`,
      };
    });
    if (firstBuild) continue;
    await check(`${name} vs served`, async () => {
      const served = await count(
        servedBinding,
        `SELECT count(*) AS n FROM ${rows}`,
      );
      return {
        ok: Math.abs(counts[name] - served) <= COUNT_TOLERANCE * served,
        detail: `${name}: ${counts[name]}, served ${served}`,
      };
    });
  }
  if (firstBuild) log("no served build to compare counts with");
  await check("red cross", async () => {
    const [row] = await ops.query<{ mission: string | null }>(
      binding,
      `SELECT f.mission FROM orgs o JOIN filings f ON f.ein = o.ein WHERE o.ein = '${RED_CROSS}'`,
    );
    const ok = Boolean(row?.mission?.trim());
    return {
      ok,
      detail: ok
        ? `${RED_CROSS} has its mission`
        : `${RED_CROSS} has no filing with a mission`,
    };
  });
  await check("red cross deductible", async () => {
    const [row] = await ops.query<{ in_pub78: number }>(
      binding,
      `SELECT in_pub78 FROM orgs WHERE ein = '${RED_CROSS}'`,
    );
    const ok = row?.in_pub78 === 1;
    return {
      ok,
      detail: ok
        ? `${RED_CROSS} is in Pub 78`
        : `${RED_CROSS} is not in Pub 78`,
    };
  });
  await check("search index", async () => {
    const [row] = await ops.query<{ index_rows: number; named_orgs: number }>(
      binding,
      "SELECT (SELECT count(*) FROM orgs_fts) AS index_rows, (SELECT count(*) FROM orgs WHERE name IS NOT NULL) AS named_orgs",
    );
    return {
      ok: row !== undefined && row.index_rows === row.named_orgs,
      detail: `${row?.index_rows} index rows, ${row?.named_orgs} named orgs`,
    };
  });
  await check("null eins", async () => {
    const n = await count(
      binding,
      "SELECT (SELECT count(*) FROM orgs WHERE ein IS NULL) + (SELECT count(*) FROM filings WHERE ein IS NULL) + (SELECT count(*) FROM programs WHERE ein IS NULL) AS n",
    );
    return { ok: n === 0, detail: `${n} rows without an EIN` };
  });
  return { counts, checks };
}

/** Indexes every named org in the target's generation, replacing what its search index held. */
export function rebuildSearchIndex(
  { ops, binding, buildId }: D1Target,
  loadDir: string,
): Promise<void> {
  return applySql(
    ops,
    binding,
    join(loadDir, "search-index.sql"),
    fenceSql(buildId) + rebuildSearchIndexSql(buildId),
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RollbackOptions {
  log?: (line: string) => void;
  /** As `RefreshOptions.onClaim`. */
  onClaim?: (buildId: string) => void;
}

/**
 * Points the Worker back at the other slot, if it holds a complete generation
 * that was served before (a build sealed but never flipped to is refused).
 * When a refresh has reset that slot since, throws with the D1 Time Travel
 * restore that brings its generation back.
 */
export async function rollback(
  ops: D1Ops,
  { log = () => {}, onClaim }: RollbackOptions = {},
): Promise<{ from: DataSlot; to: DataSlot; buildId: string }> {
  const pointer = await readPointer(ops);
  const from = pointer.active;
  const to = otherSlot(from);
  const binding = DATA_DB_BINDING[to];
  const meta = await readMeta(ops, binding);
  if (meta?.slot !== to || meta.state !== "complete") {
    throw new Error(nothingToRollBackTo(binding, to, meta));
  }
  // served before means sealed before the pointer last moved
  if (
    meta.built_at === null ||
    !(Date.parse(meta.built_at) <= Date.parse(pointer.flipped_at))
  ) {
    throw new Error(
      `rollback refused: slot ${to}'s build ${meta.build_id} was sealed at ${meta.built_at} but never served (the pointer last moved at ${pointer.flipped_at}); irs refresh rebuilds it`,
    );
  }
  await settleLastFlip(pointer, to, log);
  onClaim?.(meta.build_id);
  try {
    const claimed = await ops.query("APP_DB", claimSlotSql(to, meta.build_id));
    if (claimed.length !== 1) {
      throw new Error(
        `rollback refused: a build holds slot ${to}'s claim; wait for it to finish or its lease to run out`,
      );
    }
    log(`claimed slot ${to} (${binding}) for build ${meta.build_id}`);
    await flip(ops, from, meta.build_id, log);
  } catch (error) {
    await releaseFailedClaim(ops, meta.build_id, log);
    throw error;
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
