import { COLUMNS, DATA_TABLES, dataTablesDdl, dateCheck } from "./schema.ts";
import { searchIndexDdl } from "./search-index.ts";

/** One of the two data databases; `APP_DB`'s `data_generation` names the one served. */
export type DataSlot = "a" | "b";

/** The Worker binding (and `wrangler d1` database) each slot names. */
export const DATA_DB_BINDING = { a: "DATA_DB_A", b: "DATA_DB_B" } as const;
export type DataDbBinding = (typeof DATA_DB_BINDING)[DataSlot];

export function otherSlot(slot: DataSlot): DataSlot {
  return slot === "a" ? "b" : "a";
}

/** A text value as a SQL literal: these statements run through `wrangler d1 execute`, which can't bind parameters. */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** The database's clock, as the ISO text the protocol's timestamps hold. */
const DB_NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

/**
 * Drops every data table and builds the current schema, empty, with
 * `data_meta` saying which slot this is and which build is filling it. This
 * is the data databases' only schema source: they have no migrations. Run it
 * only on a slot this build has claimed (`claimSlotSql`).
 *
 * Data columns and tables are additive only. A rollback serves an older
 * generation, built from an older version of this DDL, to the Worker at HEAD,
 * so a column or table the Worker reads must stay in every generation still
 * flippable to. A table leaving `DATA_TABLES` keeps its DROP here, or a reset
 * leaves it behind in the slot.
 */
export function resetGenerationSql(slot: DataSlot, buildId: string): string {
  const drops = DATA_TABLES.map((t) => `DROP TABLE IF EXISTS ${t};`).join("\n");
  return `${drops}

${dataTablesDdl()}
${searchIndexDdl()}
-- Which slot this database is and the build that filled it; one row.
CREATE TABLE data_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  slot TEXT NOT NULL CHECK (slot IN ('a', 'b')),
  build_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('building', 'complete')),
  built_at TEXT CHECK (${dateCheck("built_at", "isoSeconds")})
) STRICT;

-- Once sealed, the generation is read-only until the next reset drops it.
${sealedTriggers()}
-- fenceSql's probe row: never stored, it only carries the refusal.
CREATE TRIGGER data_meta_fence BEFORE INSERT ON data_meta WHEN NEW.state = '${FENCE_PROBE}' BEGIN SELECT RAISE(ABORT, 'load refused: this slot is not building the load''s build'); END;
INSERT INTO data_meta (id, slot, build_id, state) VALUES (1, ${literal(slot)}, ${literal(buildId)}, 'building');
`;
}

/**
 * Triggers that abort every write to the loaded tables once `data_meta` says
 * complete, and any change to a complete `data_meta`. `orgs_fts` goes
 * unguarded: SQLite allows no trigger on a virtual table. A reset's DROP TABLE
 * fires none of these. One line each, so a `;`-at-line-end splitter keeps
 * each trigger whole.
 */
function sealedTriggers(): string {
  const sealed = "SELECT RAISE(ABORT, 'data generation is sealed');";
  const loaded = Object.keys(COLUMNS).flatMap((table) =>
    (["INSERT", "UPDATE", "DELETE"] as const).map(
      (op) =>
        `CREATE TRIGGER ${table}_sealed_${op.toLowerCase()} BEFORE ${op} ON ${table} WHEN (SELECT state FROM data_meta WHERE id = 1) = 'complete' BEGIN ${sealed} END;`,
    ),
  );
  const meta = (["UPDATE", "DELETE"] as const).map(
    (op) =>
      `CREATE TRIGGER data_meta_sealed_${op.toLowerCase()} BEFORE ${op} ON data_meta WHEN OLD.state = 'complete' BEGIN ${sealed} END;`,
  );
  // INSERT OR REPLACE drops the sealed row without firing the DELETE trigger
  const metaInsert = `CREATE TRIGGER data_meta_sealed_insert BEFORE INSERT ON data_meta WHEN EXISTS (SELECT 1 FROM data_meta WHERE state = 'complete') BEGIN ${sealed} END;`;
  return [...loaded, ...meta, metaInsert].join("\n");
}

const FENCE_PROBE = "fence";

/**
 * Against a data database, as the first statement of every load file for
 * `buildId`: aborts the whole file unless this slot is still `building` that
 * build. A build whose slot a newer build has reset, or that was sealed, then
 * writes nothing. Both `wrangler d1 execute --file` paths run a file
 * atomically: `--local` as one batch, `--remote` as one import.
 *
 * It inserts a probe row only when the fence fails, and the `data_meta_fence`
 * trigger turns the probe into the refusal; a slot reset before that trigger
 * existed refuses it on `data_meta`'s state CHECK. One line, so a
 * `;`-at-line-end splitter keeps it whole.
 */
export function fenceSql(buildId: string): string {
  return `INSERT INTO data_meta (id, slot, build_id, state) SELECT 1, 'a', ${literal(buildId)}, '${FENCE_PROBE}' WHERE NOT EXISTS (SELECT 1 FROM data_meta WHERE id = 1 AND build_id = ${literal(buildId)} AND state = 'building');\n`;
}

/**
 * Marks the generation `buildId` filled as complete. Returns the sealed row, or
 * no row when this database holds another build or is already sealed.
 */
export function sealGenerationSql(buildId: string): string {
  return `UPDATE data_meta SET state = 'complete', built_at = ${DB_NOW}
WHERE id = 1 AND build_id = ${literal(buildId)} AND state = 'building'
RETURNING slot, build_id, state;`;
}

/** A claim outlives the monthly import job (6 h) so it can't lapse mid-build. */
const CLAIM_LEASE_SECONDS = 8 * 60 * 60;

/** How long a Worker isolate serves the slot it read before reading the pointer again. */
export const POINTER_TTL_MS = 30_000;

/**
 * How long after a flip the slot it left may still be served: twice the
 * pointer cache, so every isolate has reread the pointer since. `claimSlotSql`
 * refuses a claim inside it.
 */
export const FLIP_SETTLE_MS = 2 * POINTER_TTL_MS;

const CLAIM_COLUMNS =
  "claim_slot, claim_build_id, claimed_at, claim_expires_at";

/**
 * Against `APP_DB`: claims `target` for `buildId` before it is reset. Succeeds
 * only while `target` is not the active slot, no other build's lease is
 * running, and the last flip is at least `FLIP_SETTLE_MS` old; returns the
 * claim, or no row when refused. A reset without a claim can drop the slot
 * another run just flipped live; one inside the settle can drop the slot a
 * flip just left, which isolates still caching the old pointer serve.
 *
 * Every time here is the database's clock, as is `flipped_at`, so no runner's
 * skewed clock can end another build's lease or shorten the settle.
 *
 * An isolate whose pointer reread fails keeps the slot it last served
 * (`activeDataDb`) only until `FLIP_SETTLE_MS` past its last good read, so
 * the settle bounds it too.
 *
 * @param _at ignored: the database stamps the claim. Kept so callers that
 * still pass their own clock compile.
 */
export function claimSlotSql(
  target: DataSlot,
  buildId: string,
  _at?: string,
  leaseSeconds = CLAIM_LEASE_SECONDS,
): string {
  return `UPDATE data_generation SET claim_slot = ${literal(target)}, claim_build_id = ${literal(buildId)}, claimed_at = ${DB_NOW},
  claim_expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+${Math.trunc(leaseSeconds)} seconds')
WHERE id = 1 AND active != ${literal(target)}
  AND (claim_build_id IS NULL OR julianday(claim_expires_at) <= julianday('now'))
  AND (julianday('now') - julianday(flipped_at)) * 86400 >= ${FLIP_SETTLE_MS / 1000}
RETURNING ${CLAIM_COLUMNS};`;
}

/** Against `APP_DB`: gives up `buildId`'s claim, after a failed build. Returns one row when it held the claim, none otherwise. */
export function releaseClaimSql(buildId: string): string {
  return `UPDATE data_generation SET claim_slot = NULL, claim_build_id = NULL, claimed_at = NULL, claim_expires_at = NULL
WHERE id = 1 AND claim_build_id = ${literal(buildId)}
RETURNING ${literal(buildId)} AS released_build_id;`;
}

/**
 * Against `APP_DB`: points `data_generation` from `from` to the other slot,
 * the one `buildId` claimed, and clears the claim. Returns the new row, or no
 * row when `from` is no longer active or `buildId` holds no claim. The caller
 * verifies the target first: its `data_meta` sealed `complete` for `buildId`.
 * The Worker refuses to switch to a slot that isn't, but this statement can't
 * read another database. `flipped_at` is the database's clock.
 *
 * @param _at ignored, as `claimSlotSql`'s is.
 */
export function flipActiveSlotSql(
  from: DataSlot,
  buildId: string,
  _at?: string,
): string {
  const to = otherSlot(from);
  return `UPDATE data_generation SET active = ${literal(to)}, build_id = ${literal(buildId)}, flipped_at = ${DB_NOW},
  claim_slot = NULL, claim_build_id = NULL, claimed_at = NULL, claim_expires_at = NULL
WHERE id = 1 AND active = ${literal(from)} AND claim_slot = ${literal(to)} AND claim_build_id = ${literal(buildId)}
RETURNING active, build_id, flipped_at;`;
}

/** `APP_DB`'s `data_generation` row: the slot served, the build in it, and when it was flipped to. */
export interface Pointer {
  active: DataSlot;
  build_id: string;
  flipped_at: string;
}

/** `APP_DB`'s claim on the slot not served; every field null when no build holds it. */
export interface Claim {
  claim_slot: DataSlot | null;
  claim_build_id: string | null;
  claimed_at: string | null;
  claim_expires_at: string | null;
}

/** A data database's `data_meta` row, as `READ_DATA_META_SQL` reads it. */
export interface DataMeta {
  slot: DataSlot;
  build_id: string;
  state: "building" | "complete";
}

/** Against `APP_DB`: the slot the Worker serves, as a `Pointer`. */
export const READ_ACTIVE_SLOT_SQL =
  "SELECT active, build_id, flipped_at FROM data_generation WHERE id = 1";

/** Against `APP_DB`: the build holding the slot not served, as a `Claim`. */
export const READ_CLAIM_SQL = `SELECT ${CLAIM_COLUMNS} FROM data_generation WHERE id = 1`;

/** Against a data database: which slot it is, and its build's state, as a `DataMeta`. */
export const READ_DATA_META_SQL =
  "SELECT slot, build_id, state FROM data_meta WHERE id = 1";

/**
 * Whether the slot `pointer` names may be served, given that slot's own
 * `data_meta`: it says it is that slot, sealed for the pointer's build. A flip
 * to a half-built or miswired database is never served.
 */
export function isServable(
  pointer: Pointer,
  meta: DataMeta | undefined,
): boolean {
  return (
    meta?.slot === pointer.active &&
    meta.build_id === pointer.build_id &&
    meta.state === "complete"
  );
}
