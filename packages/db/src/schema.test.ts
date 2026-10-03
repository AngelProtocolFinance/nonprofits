import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { COLUMNS, dataTablesDdl, resetGenerationSql } from "./index.ts";

function fromDdl(ddl: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(ddl);
  return db;
}

describe("dataTablesDdl", () => {
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

describe("COLUMNS", () => {
  test("lists every column of every loaded table a reset builds, in order", () => {
    const db = fromDdl(resetGenerationSql("a", "build-1"));
    for (const [table, columns] of Object.entries(COLUMNS)) {
      const actual = (
        db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as {
          name: string;
        }[]
      ).map((c) => c.name);
      expect(actual, table).toEqual(columns);
    }
  });
});
