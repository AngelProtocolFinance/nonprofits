import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import {
  COLUMNS,
  dataTablesDdl,
  SWAPPED_TABLES,
  searchIndexDdl,
} from "./index.ts";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

async function migrated(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql"));
  for (const file of files.sort()) {
    db.exec(await readFile(new URL(file, MIGRATIONS), "utf8"));
  }
  return db;
}

function fromDdl(ddl: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(ddl);
  return db;
}

/** CREATE statements as SQLite stored them, comments and layout dropped. */
function schemaOf(db: DatabaseSync, names: readonly string[]): string[] {
  const rows = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND tbl_name IN (SELECT value FROM json_each(?)) ORDER BY name",
    )
    .all(JSON.stringify(names)) as { sql: string }[];
  return rows.map(({ sql }) =>
    sql
      .replace(/--[^\n]*/g, "")
      .replace(/\s+/g, " ")
      .replace(/\s*([(),])\s*/g, "$1")
      .trim(),
  );
}

describe("dataTablesDdl", () => {
  test("matches the schema the migrations build", async () => {
    expect(schemaOf(fromDdl(dataTablesDdl("")), SWAPPED_TABLES)).toEqual(
      schemaOf(await migrated(), SWAPPED_TABLES),
    );
  });

  test("builds suffixed tables whose foreign keys stay among themselves", () => {
    const db = fromDdl(dataTablesDdl("_next"));
    const targets = db
      .prepare(
        `SELECT DISTINCT m.name AS child, f."table" AS parent
         FROM sqlite_schema m, pragma_foreign_key_list(m.name) f
         WHERE m.type = 'table' ORDER BY child, parent`,
      )
      .all();
    expect(targets).toEqual([
      { child: "filings_next", parent: "import_runs_next" },
      { child: "filings_next", parent: "orgs_next" },
      { child: "orgs_next", parent: "import_runs_next" },
      { child: "programs_next", parent: "filings_next" },
    ]);
  });
});

describe("searchIndexDdl", () => {
  test("matches the index the migrations build", async () => {
    expect(schemaOf(fromDdl(searchIndexDdl("")), ["orgs_fts"])).toEqual(
      schemaOf(await migrated(), ["orgs_fts"]),
    );
  });
});

describe("COLUMNS", () => {
  test("lists every column of every swapped table, in order", async () => {
    const db = await migrated();
    for (const table of SWAPPED_TABLES) {
      const actual = (
        db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as {
          name: string;
        }[]
      ).map((c) => c.name);
      expect(actual, table).toEqual(COLUMNS[table]);
    }
  });
});
