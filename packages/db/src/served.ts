import type { Client, Row } from "@libsql/client";

/** The pointer's `build_id` until the first build switches it (`0003_data_generation.sql`, `0004_served_database.sql`). */
export const NEVER_BUILT = "empty";

/** A Turso data database: its name, as the Platform API knows it, and the URL a client opens. */
export interface ServedDatabase {
  name: string;
  url: string;
}

/** The app database's `served_database` row: what the api serves, the build in it, and when it was switched to. */
export interface ServedPointer {
  /** null until the first build switches to one; `build_id` is then `NEVER_BUILT` */
  database: ServedDatabase | null;
  build_id: string;
  switched_at: string;
}

const POINTER_COLUMNS = "database_name, database_url, build_id, switched_at";

function pointerOf(row: Row): ServedPointer {
  const { database_name: name, database_url: url } = row;
  return {
    database:
      typeof name === "string" && typeof url === "string"
        ? { name, url }
        : null,
    build_id: String(row.build_id),
    switched_at: String(row.switched_at),
  };
}

/** Against the app database: the data database served now. */
export async function readServedDatabase(app: Client): Promise<ServedPointer> {
  const rs = await app.execute(
    `SELECT ${POINTER_COLUMNS} FROM served_database WHERE id = 1`,
  );
  const row = rs.rows[0];
  if (!row)
    throw new Error("served_database has no row: migrate the app database");
  return pointerOf(row);
}

export type SwitchResult =
  | { switched: true; pointer: ServedPointer }
  /** `pointer` is what is served instead: another switch got there first */
  | { switched: false; pointer: ServedPointer };

/**
 * Against the app database: serves `to`, holding `buildId`, if `expected`
 * (a database name, or null for never built) is still the one served. A switch
 * that raced another one changes nothing and reports what is served now. The
 * time stamped is the database's clock. The caller verifies `to` first
 * (`servesBuild`): a switch can't read another database.
 */
export async function switchServedDatabase(
  app: Client,
  {
    expected,
    to,
    buildId,
  }: { expected: string | null; to: ServedDatabase; buildId: string },
): Promise<SwitchResult> {
  const [update, read] = await app.batch(
    [
      {
        sql: `UPDATE served_database SET database_name = ?, database_url = ?, build_id = ?,
  switched_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE id = 1 AND database_name IS ?`,
        args: [to.name, to.url, buildId, expected],
      },
      `SELECT ${POINTER_COLUMNS} FROM served_database WHERE id = 1`,
    ],
    "write",
  );
  const row = read?.rows[0];
  if (!update || !row)
    throw new Error("served_database has no row: migrate the app database");
  return { switched: update.rowsAffected === 1, pointer: pointerOf(row) };
}
