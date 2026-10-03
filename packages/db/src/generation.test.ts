import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import {
  DATA_TABLES,
  flipActiveSlotSql,
  otherSlot,
  READ_ACTIVE_SLOT_SQL,
  READ_DATA_META_SQL,
  rebuildSearchIndexSql,
  resetGenerationSql,
  sealGenerationSql,
} from "./index.ts";

function dataDb(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

const APP_MIGRATIONS = new URL("../migrations/app/", import.meta.url);

/** A fresh app database with every app migration applied, as `wrangler d1 migrations apply` would. */
async function appDb(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  const files = (await readdir(APP_MIGRATIONS)).filter((f) =>
    f.endsWith(".sql"),
  );
  for (const file of files.sort()) {
    db.exec(await readFile(new URL(file, APP_MIGRATIONS), "utf8"));
  }
  return db;
}

/** Every schema object as SQLite stored it, FTS shadow tables included. */
function schemaOf(db: DatabaseSync): unknown[] {
  return db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name",
    )
    .all();
}

/** Tables a reset owns: everything but FTS5's shadow tables. */
function tablesOf(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'orgs_fts_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

describe("resetGenerationSql", () => {
  test("builds an empty generation marked building for its slot", () => {
    const db = dataDb();

    db.exec(resetGenerationSql("b", "2026-10-03T04:00:00Z"));

    expect(db.prepare(READ_DATA_META_SQL).all()).toEqual([
      { slot: "b", build_id: "2026-10-03T04:00:00Z", state: "building" },
    ]);
    expect(db.prepare("SELECT count(*) AS n FROM orgs").get()).toEqual({
      n: 0,
    });
  });

  test("over a filled generation, rebuilds the same schema with no rows", () => {
    const db = dataDb();
    db.exec(resetGenerationSql("a", "build-1"));
    const fresh = schemaOf(db);
    db.exec(`
      INSERT INTO import_runs VALUES (1, 'efile_xml', 'https://example.invalid/x.zip', '2026-09-04', '2026-09-10', 1);
      INSERT INTO orgs (ein, name, name_run_id) VALUES ('530196605', 'AMERICAN NATIONAL RED CROSS', 1);
      INSERT INTO filings (ein, object_id, form_type, tax_period, tax_year, run_id)
        VALUES ('530196605', '202511319349301234', '990', '2025-06', 2024, 1);
      INSERT INTO programs (ein, object_id, rank) VALUES ('530196605', '202511319349301234', 1);
      UPDATE data_meta SET state = 'complete';
    `);
    db.exec(rebuildSearchIndexSql(""));

    db.exec(resetGenerationSql("a", "build-2"));

    expect(schemaOf(db)).toEqual(fresh);
    expect(tablesOf(db)).toEqual([...DATA_TABLES].sort());
    const rows = DATA_TABLES.filter((t) => t !== "data_meta").map(
      (t) =>
        (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n,
    );
    expect(rows).toEqual([0, 0, 0, 0, 0]);
    expect(db.prepare(READ_DATA_META_SQL).all()).toEqual([
      { slot: "a", build_id: "build-2", state: "building" },
    ]);
  });
});

describe("sealGenerationSql", () => {
  test("marks the build it names complete, once", () => {
    const db = dataDb();
    db.exec(resetGenerationSql("b", "build-1"));

    const sealed = db.prepare(sealGenerationSql("build-1")).all();
    const again = db.prepare(sealGenerationSql("build-1")).all();

    expect(sealed).toEqual([
      { slot: "b", build_id: "build-1", state: "complete" },
    ]);
    expect(again).toEqual([]);
    const { built_at } = db.prepare("SELECT built_at FROM data_meta").get() as {
      built_at: string;
    };
    expect(built_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  test("leaves a slot another build reset untouched", () => {
    const db = dataDb();
    db.exec(resetGenerationSql("b", "build-2"));

    expect(db.prepare(sealGenerationSql("build-1")).all()).toEqual([]);
    expect(db.prepare(READ_DATA_META_SQL).all()).toEqual([
      { slot: "b", build_id: "build-2", state: "building" },
    ]);
  });
});

describe("the active-slot pointer", () => {
  test("starts on slot a with no build", async () => {
    const db = await appDb();

    expect(db.prepare(READ_ACTIVE_SLOT_SQL).all()).toEqual([
      { active: "a", build_id: "empty" },
    ]);
  });

  test("flips to the other slot when it still names the slot flipped from", async () => {
    const db = await appDb();

    const flipped = db
      .prepare(flipActiveSlotSql("a", "b", "build-1", "2026-10-03T05:00:00Z"))
      .all();

    expect(flipped).toEqual([
      {
        active: "b",
        build_id: "build-1",
        flipped_at: "2026-10-03T05:00:00Z",
      },
    ]);
    expect(db.prepare(READ_ACTIVE_SLOT_SQL).all()).toEqual([
      { active: "b", build_id: "build-1" },
    ]);
  });

  test("refuses a flip from a slot that is no longer active", async () => {
    const db = await appDb();
    db.prepare(
      flipActiveSlotSql("a", "b", "build-1", "2026-10-03T05:00:00Z"),
    ).all();

    const stale = db
      .prepare(flipActiveSlotSql("a", "b", "build-2", "2026-10-03T06:00:00Z"))
      .all();

    expect(stale).toEqual([]);
    expect(db.prepare(READ_ACTIVE_SLOT_SQL).all()).toEqual([
      { active: "b", build_id: "build-1" },
    ]);
  });
});

describe("slots", () => {
  test("each slot's other is the one a refresh builds into", () => {
    expect([otherSlot("a"), otherSlot("b")]).toEqual(["b", "a"]);
  });
});
