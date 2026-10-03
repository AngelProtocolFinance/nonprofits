import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { rebuildSearchIndexSql, resetGenerationSql } from "./index.ts";

/** A generation still building, holding `names` keyed by EIN. */
function loaded(names: Record<string, string>): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(resetGenerationSql("a", "build-1"));
  db.exec(
    "INSERT INTO import_runs VALUES (1, 'bmf', 'https://example.invalid/bmf', '2026-09-08', '2026-09-10', 0)",
  );
  const insert = db.prepare(
    "INSERT INTO orgs (ein, name, name_run_id) VALUES (?, ?, 1)",
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
    const db = loaded({
      "012345678": "RED CROSS OF MAINE",
      "530196605": "AMERICAN NATIONAL RED CROSS",
      "990000001": "RED RIVER FOOD BANK",
    });
    db.exec(rebuildSearchIndexSql("build-1"));
    expect(matches(db, "red cross")).toEqual(["012345678", "530196605"]);
    expect(matches(db, "red")).toEqual(["012345678", "530196605", "990000001"]);
  });

  test("a second rebuild forgets names orgs no longer holds", () => {
    const db = loaded({ "012345678": "RED CROSS OF MAINE" });
    db.exec(rebuildSearchIndexSql("build-1"));
    db.exec("UPDATE orgs SET name = 'MAINE BLOOD SERVICES'");
    db.exec(rebuildSearchIndexSql("build-1"));
    expect(matches(db, "blood")).toEqual(["012345678"]);
    expect(matches(db, "red")).toEqual([]);
  });

  test("heads each build's file with its build id, so no two builds upload the same bytes", () => {
    const first = rebuildSearchIndexSql("2026-10-03T04:00:00Z");
    const second = rebuildSearchIndexSql("2026-11-03T04:00:00Z");

    expect(first.split("\n")[0]).toBe("-- build 2026-10-03T04:00:00Z");
    expect(first).not.toBe(second);
  });

  test("refuses a build id that would end its comment line", () => {
    expect(() => rebuildSearchIndexSql("x\nDROP TABLE orgs;")).toThrow(
      "a build id is one line",
    );
  });
});
