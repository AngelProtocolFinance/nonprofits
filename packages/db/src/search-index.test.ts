import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import {
  dataTablesDdl,
  rebuildSearchIndexSql,
  searchIndexDdl,
} from "./index.ts";

function loaded(suffix: string, names: Record<string, string>): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(dataTablesDdl(suffix));
  db.exec(searchIndexDdl(suffix));
  db.exec(
    `INSERT INTO import_runs${suffix} VALUES (1, 'bmf', 'https://example.invalid/bmf', '2026-09-08', '2026-09-10', 0)`,
  );
  const insert = db.prepare(
    `INSERT INTO orgs${suffix} (ein, name, name_run_id) VALUES (?, ?, 1)`,
  );
  for (const [ein, name] of Object.entries(names)) insert.run(ein, name);
  return db;
}

function matches(db: DatabaseSync, query: string): string[] {
  return (
    db
      .prepare(
        "SELECT printf('%09d', rowid) AS ein FROM orgs_fts WHERE orgs_fts MATCH ? ORDER BY rowid",
      )
      .all(query) as { ein: string }[]
  ).map((r) => r.ein);
}

describe("rebuildSearchIndexSql", () => {
  test("indexes every named org under its EIN, leading zeros kept", () => {
    const db = loaded("", {
      "012345678": "RED CROSS OF MAINE",
      "530196605": "AMERICAN NATIONAL RED CROSS",
      "990000001": "RED RIVER FOOD BANK",
    });
    db.exec(rebuildSearchIndexSql(""));
    expect(matches(db, "red cross")).toEqual(["012345678", "530196605"]);
    expect(matches(db, "red")).toEqual(["012345678", "530196605", "990000001"]);
  });

  test("a second rebuild forgets names orgs no longer holds", () => {
    const db = loaded("", { "012345678": "RED CROSS OF MAINE" });
    db.exec(rebuildSearchIndexSql(""));
    db.exec("UPDATE orgs SET name = 'MAINE BLOOD SERVICES'");
    db.exec(rebuildSearchIndexSql(""));
    expect(matches(db, "blood")).toEqual(["012345678"]);
    expect(matches(db, "red")).toEqual([]);
  });

  test("a suffixed index renames into place with its shadow tables", () => {
    const db = loaded("_next", { "530196605": "AMERICAN NATIONAL RED CROSS" });
    db.exec(rebuildSearchIndexSql("_next"));
    db.exec("ALTER TABLE orgs_fts_next RENAME TO orgs_fts");
    expect(matches(db, "red cross")).toEqual(["530196605"]);
    const leftovers = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name LIKE 'orgs_fts_next%'",
      )
      .all();
    expect(leftovers).toEqual([]);
  });
});
