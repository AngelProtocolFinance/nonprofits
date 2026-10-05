import type { Client } from "@libsql/client";
import { dataTablesDdl, dateCheck } from "./schema.ts";
import { searchIndexDdl } from "./search-index.ts";

const DATA_META_DDL = `-- The build that filled this database; one row, written by finishDataDatabase
-- once the load is done. A database without it is unfinished and never served.
-- counts: the build's row counts as a JSON object by name, recorded by
-- recordCounts once verify passed; null on a database finished without them.
CREATE TABLE data_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  build_id TEXT NOT NULL,
  built_at TEXT NOT NULL CHECK (${dateCheck("built_at", "isoSeconds")}),
  counts TEXT CHECK (json_valid(counts))
) STRICT;
`;

/**
 * Builds the data schema, empty, in a new database: the loaded tables, the
 * search index and `data_meta`. Each month's build is a new database, so there
 * is nothing to drop and no migrations.
 */
export async function createDataDatabase(data: Client): Promise<void> {
  await data.executeMultiple(
    `${dataTablesDdl()}\n${searchIndexDdl()}\n${DATA_META_DDL}`,
  );
}

/**
 * Indexes every named org for search and records `buildId` as built, at the
 * database's clock, in one transaction: the last write a build makes. A
 * second call fails on `data_meta`'s one row.
 */
export async function finishDataDatabase(
  data: Client,
  buildId: string,
): Promise<void> {
  await data.batch(
    [
      "INSERT INTO orgs_fts (rowid, name) SELECT CAST(ein AS INTEGER), name FROM orgs WHERE name IS NOT NULL",
      {
        sql: "INSERT INTO data_meta (id, build_id, built_at) VALUES (1, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
        args: [buildId],
      },
    ],
    "write",
  );
}

/** A data database's `data_meta` row. */
export interface DataBuild {
  build_id: string;
  built_at: string;
}

/** Against a data database: the build that finished it, or undefined while unfinished. */
export async function readDataMeta(
  data: Client,
): Promise<DataBuild | undefined> {
  const rs = await data.execute(
    "SELECT build_id, built_at FROM data_meta WHERE id = 1",
  );
  const row = rs.rows[0];
  return row
    ? { build_id: String(row.build_id), built_at: String(row.built_at) }
    : undefined;
}

/**
 * Records a finished data database's row counts, by name, for a later build to
 * compare its own with by reading this one row instead of counting.
 */
export async function recordCounts(
  data: Client,
  counts: Readonly<Record<string, number>>,
): Promise<void> {
  const rs = await data.execute({
    sql: "UPDATE data_meta SET counts = ? WHERE id = 1",
    args: [JSON.stringify(counts)],
  });
  if (rs.rowsAffected !== 1) {
    throw new Error(
      "an unfinished data database has no data_meta row to record counts on",
    );
  }
}

/**
 * Against a finished data database: the counts its build recorded, or
 * undefined where it recorded none, as a database built before `counts`
 * existed has no such column.
 */
export async function readDataCounts(
  data: Client,
): Promise<Record<string, number> | undefined> {
  // `*`, not `counts`: naming a column an older database lacks fails the query
  const rs = await data.execute("SELECT * FROM data_meta WHERE id = 1");
  const counts = rs.rows[0]?.counts;
  return typeof counts === "string" ? JSON.parse(counts) : undefined;
}

/**
 * Whether a data database whose `data_meta` reads `meta` holds `buildId`,
 * finished. The import checks it on the uploaded database before switching to
 * it; the api checks the served database against the pointer's `build_id`, so
 * an unfinished or mismatched database is never served.
 */
export function holdsBuild(
  buildId: string,
  meta: DataBuild | undefined,
): boolean {
  return meta?.build_id === buildId;
}
