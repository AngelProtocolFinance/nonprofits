import { DATA_TABLES, dataTablesDdl } from "./schema.ts";
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
 * is the data databases' only schema source: they have no migrations.
 *
 * Data columns are additive only. A rollback serves an older generation, built
 * from an older version of this DDL, to the Worker at HEAD, so a column the
 * Worker reads must stay in every generation still flippable to.
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

INSERT INTO data_meta (id, slot, build_id, state) VALUES (1, ${literal(slot)}, ${literal(buildId)}, 'building');
`;
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

/**
 * Points `APP_DB`'s `data_generation` at `to`, but only while it still names
 * `from`: returns the new row, or no row when another flip got there first.
 */
export function flipActiveSlotSql(
  from: DataSlot,
  to: DataSlot,
  buildId: string,
  at: string,
): string {
  return `UPDATE data_generation SET active = ${literal(to)}, build_id = ${literal(buildId)}, flipped_at = ${literal(at)}
WHERE id = 1 AND active = ${literal(from)}
RETURNING active, build_id, flipped_at;`;
}

/** Against `APP_DB`: the slot the Worker serves. */
export const READ_ACTIVE_SLOT_SQL =
  "SELECT active, build_id FROM data_generation WHERE id = 1";

/** Against a data database: which slot it is, and its build's state. */
export const READ_DATA_META_SQL =
  "SELECT slot, build_id, state FROM data_meta WHERE id = 1";
