import { COLUMNS, DATA_TABLES, dataTablesDdl } from "./schema.ts";
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

${dataTablesDdl("")}
${searchIndexDdl("")}
-- Which slot this database is and the build that filled it; one row.
CREATE TABLE data_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  slot TEXT NOT NULL CHECK (slot IN ('a', 'b')),
  build_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('building', 'complete')),
  built_at TEXT
) STRICT;

-- Once sealed, the generation is read-only until the next reset drops it.
${sealedTriggers()}
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
  return [...loaded, ...meta].join("\n");
}

/**
 * Marks the generation `buildId` filled as complete. Returns the sealed row, or
 * no row when this database holds another build or is already sealed.
 */
export function sealGenerationSql(buildId: string): string {
  return `UPDATE data_meta SET state = 'complete', built_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE id = 1 AND build_id = ${literal(buildId)} AND state = 'building'
RETURNING slot, build_id, state;`;
}

/** A claim outlives the monthly import job (6 h) so it can't lapse mid-build. */
const CLAIM_LEASE_SECONDS = 8 * 60 * 60;

const CLAIM_COLUMNS =
  "claim_slot, claim_build_id, claimed_at, claim_expires_at";

/**
 * Against `APP_DB`: claims `target` for `buildId` before it is reset. Succeeds
 * only while `target` is not the active slot and no other build's lease is
 * running; returns the claim, or no row when refused. A reset without a claim
 * can drop the slot another run just flipped live.
 */
export function claimSlotSql(
  target: DataSlot,
  buildId: string,
  at: string,
  leaseSeconds = CLAIM_LEASE_SECONDS,
): string {
  return `UPDATE data_generation SET claim_slot = ${literal(target)}, claim_build_id = ${literal(buildId)}, claimed_at = ${literal(at)},
  claim_expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', ${literal(at)}, '+${Math.trunc(leaseSeconds)} seconds')
WHERE id = 1 AND active != ${literal(target)}
  AND (claim_build_id IS NULL OR julianday(claim_expires_at) <= julianday(${literal(at)}))
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
 * read another database.
 */
export function flipActiveSlotSql(
  from: DataSlot,
  buildId: string,
  at: string,
): string {
  const to = otherSlot(from);
  return `UPDATE data_generation SET active = ${literal(to)}, build_id = ${literal(buildId)}, flipped_at = ${literal(at)},
  claim_slot = NULL, claim_build_id = NULL, claimed_at = NULL, claim_expires_at = NULL
WHERE id = 1 AND active = ${literal(from)} AND claim_slot = ${literal(to)} AND claim_build_id = ${literal(buildId)}
RETURNING active, build_id, flipped_at;`;
}

/** Against `APP_DB`: the slot the Worker serves. */
export const READ_ACTIVE_SLOT_SQL =
  "SELECT active, build_id FROM data_generation WHERE id = 1";

/** Against a data database: which slot it is, and its build's state. */
export const READ_DATA_META_SQL =
  "SELECT slot, build_id, state FROM data_meta WHERE id = 1";
