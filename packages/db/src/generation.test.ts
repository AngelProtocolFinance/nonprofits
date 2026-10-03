import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import {
  claimSlotSql,
  DATA_TABLES,
  flipActiveSlotSql,
  otherSlot,
  READ_ACTIVE_SLOT_SQL,
  READ_DATA_META_SQL,
  rebuildSearchIndexSql,
  releaseClaimSql,
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

/** One row in each loaded table. */
const FILL = `
  INSERT INTO import_runs VALUES (1, 'efile_xml', 'https://example.invalid/x.zip', '2026-09-04', '2026-09-10', 1);
  INSERT INTO orgs (ein, name, name_run_id) VALUES ('530196605', 'AMERICAN NATIONAL RED CROSS', 1);
  INSERT INTO filings (ein, object_id, form_type, tax_period, tax_year, run_id)
    VALUES ('530196605', '202511319349301234', '990', '2025-06', 2024, 1);
  INSERT INTO programs (ein, object_id, rank) VALUES ('530196605', '202511319349301234', 1);
`;

/** What running each statement did: "written", or the error it raised. */
function outcomes(db: DatabaseSync, statements: string[]): string[] {
  return statements.map((sql) => {
    try {
      db.exec(sql);
      return "written";
    } catch (error) {
      return (error as Error).message;
    }
  });
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
    db.exec(FILL);
    db.exec(rebuildSearchIndexSql(""));
    db.prepare(sealGenerationSql("build-1")).all();

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

describe("a sealed generation", () => {
  const WRITES = [
    "INSERT INTO import_runs VALUES (2, 'bmf', 'https://example.invalid/bmf', '2026-09-08', '2026-09-10', 0)",
    "UPDATE import_runs SET row_count = 2 WHERE id = 1",
    "DELETE FROM import_runs WHERE id = 1",
    "INSERT INTO orgs (ein) VALUES ('131624100')",
    "UPDATE orgs SET name = 'RENAMED', name_run_id = 1 WHERE ein = '530196605'",
    "DELETE FROM orgs WHERE ein = '530196605'",
    "INSERT INTO filings (ein, object_id, form_type, tax_period, tax_year, run_id) VALUES ('530196605', '1', '990', '2025-06', 2024, 1)",
    "UPDATE filings SET mission = 'X' WHERE ein = '530196605'",
    "DELETE FROM filings WHERE ein = '530196605'",
    "INSERT INTO programs (ein, object_id, rank) VALUES ('530196605', '202511319349301234', 2)",
    "UPDATE programs SET expense = 1 WHERE rank = 1",
    "DELETE FROM programs WHERE rank = 1",
    "UPDATE data_meta SET state = 'building'",
    "DELETE FROM data_meta",
  ];

  function sealed(): DatabaseSync {
    const db = dataDb();
    db.exec(resetGenerationSql("a", "build-1"));
    db.exec(FILL);
    db.prepare(sealGenerationSql("build-1")).all();
    return db;
  }

  test("refuses every write to its tables and its seal", () => {
    const db = sealed();

    expect(outcomes(db, WRITES)).toEqual(
      WRITES.map(() => "data generation is sealed"),
    );
    expect(db.prepare(READ_DATA_META_SQL).all()).toEqual([
      { slot: "a", build_id: "build-1", state: "complete" },
    ]);
  });

  test("takes writes again once reset", () => {
    const db = sealed();

    db.exec(resetGenerationSql("a", "build-2"));
    db.exec(FILL);

    expect(
      outcomes(db, [
        "INSERT INTO orgs (ein) VALUES ('131624100')",
        "UPDATE orgs SET name = 'RENAMED', name_run_id = 1 WHERE ein = '530196605'",
        "DELETE FROM programs WHERE rank = 1",
      ]),
    ).toEqual(["written", "written", "written"]);
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
  test("starts on slot a with no build and no claim", async () => {
    const db = await appDb();

    expect(db.prepare(READ_ACTIVE_SLOT_SQL).all()).toEqual([
      { active: "a", build_id: "empty", flipped_at: "1970-01-01T00:00:00Z" },
    ]);
    expect(claimOf(db)).toEqual(NO_CLAIM);
  });
});

const NO_CLAIM = {
  claim_slot: null,
  claim_build_id: null,
  claimed_at: null,
  claim_expires_at: null,
};

function claimOf(db: DatabaseSync): unknown {
  return db
    .prepare(
      "SELECT claim_slot, claim_build_id, claimed_at, claim_expires_at FROM data_generation",
    )
    .get();
}

describe("claimSlotSql", () => {
  test("claims the inactive slot for a build, for an 8 h lease", async () => {
    const db = await appDb();

    const claimed = db
      .prepare(claimSlotSql("b", "build-1", "2026-10-03T05:00:00Z"))
      .all();

    expect(claimed).toEqual([
      {
        claim_slot: "b",
        claim_build_id: "build-1",
        claimed_at: "2026-10-03T05:00:00Z",
        claim_expires_at: "2026-10-03T13:00:00Z",
      },
    ]);
  });

  test("refuses the active slot", async () => {
    const db = await appDb();

    expect(
      db.prepare(claimSlotSql("a", "build-1", "2026-10-03T05:00:00Z")).all(),
    ).toEqual([]);
    expect(claimOf(db)).toEqual(NO_CLAIM);
  });

  test("refuses while another build's lease runs, and claims once it has run out", async () => {
    const db = await appDb();
    db.prepare(
      claimSlotSql("b", "build-1", "2026-10-03T05:00:00Z", 3600),
    ).all();

    const during = db
      .prepare(claimSlotSql("b", "build-2", "2026-10-03T05:59:59Z"))
      .all();
    const after = db
      .prepare(claimSlotSql("b", "build-2", "2026-10-03T06:00:00Z"))
      .all();

    expect(during).toEqual([]);
    expect(after).toMatchObject([{ claim_build_id: "build-2" }]);
  });
});

describe("claimSlotSql after a flip", () => {
  /** An app DB whose last flip, to b, was `secondsAgo` before the database's own clock. */
  async function flippedAgo(secondsAgo: number): Promise<DatabaseSync> {
    const db = await appDb();
    db.prepare(claimSlotSql("b", "build-1", "2026-10-03T05:00:00Z")).all();
    const at = new Date(Date.now() - secondsAgo * 1000).toISOString();
    db.prepare(flipActiveSlotSql("a", "build-1", at)).all();
    return db;
  }

  // the claim's own `at` says the flip is long past: the database's clock decides
  const LATER = "2099-01-01T00:00:00Z";

  test("refuses the slot the flip left while Workers may still serve it", async () => {
    const db = await flippedAgo(50);

    expect(db.prepare(claimSlotSql("a", "build-2", LATER)).all()).toEqual([]);
  });

  test("claims the slot the flip left once 60 s have passed", async () => {
    const db = await flippedAgo(70);

    expect(db.prepare(claimSlotSql("a", "build-2", LATER)).all()).toMatchObject(
      [{ claim_slot: "a", claim_build_id: "build-2" }],
    );
  });
});

describe("releaseClaimSql", () => {
  test("frees the claim only for the build holding it", async () => {
    const db = await appDb();
    db.prepare(claimSlotSql("b", "build-1", "2026-10-03T05:00:00Z")).all();

    const other = db.prepare(releaseClaimSql("build-2")).all();
    const own = db.prepare(releaseClaimSql("build-1")).all();

    expect(other).toEqual([]);
    expect(own).toEqual([{ released_build_id: "build-1" }]);
    expect(claimOf(db)).toEqual(NO_CLAIM);
  });
});

describe("flipActiveSlotSql", () => {
  test("flips to the slot the build claimed and clears the claim", async () => {
    const db = await appDb();
    db.prepare(claimSlotSql("b", "build-1", "2026-10-03T05:00:00Z")).all();

    const flipped = db
      .prepare(flipActiveSlotSql("a", "build-1", "2026-10-03T06:00:00Z"))
      .all();

    expect(flipped).toEqual([
      { active: "b", build_id: "build-1", flipped_at: "2026-10-03T06:00:00Z" },
    ]);
    expect(db.prepare(READ_ACTIVE_SLOT_SQL).all()).toEqual([
      { active: "b", build_id: "build-1", flipped_at: "2026-10-03T06:00:00Z" },
    ]);
    expect(claimOf(db)).toEqual(NO_CLAIM);
  });

  test("refuses a build that holds no claim", async () => {
    const db = await appDb();
    const unclaimed = db
      .prepare(flipActiveSlotSql("a", "build-1", "2026-10-03T06:00:00Z"))
      .all();
    db.prepare(claimSlotSql("b", "build-2", "2026-10-03T05:00:00Z")).all();

    const anothers = db
      .prepare(flipActiveSlotSql("a", "build-1", "2026-10-03T06:00:00Z"))
      .all();

    expect([unclaimed, anothers]).toEqual([[], []]);
    expect(db.prepare(READ_ACTIVE_SLOT_SQL).all()).toEqual([
      { active: "a", build_id: "empty", flipped_at: "1970-01-01T00:00:00Z" },
    ]);
  });

  test("refuses a flip from a slot that is no longer active", async () => {
    const db = await appDb();
    db.prepare(claimSlotSql("b", "build-1", "2026-10-03T05:00:00Z")).all();
    db.prepare(flipActiveSlotSql("a", "build-1", "2026-10-03T06:00:00Z")).all();
    db.prepare(claimSlotSql("a", "build-2", "2026-10-03T07:00:00Z")).all();

    const stale = db
      .prepare(flipActiveSlotSql("a", "build-2", "2026-10-03T08:00:00Z"))
      .all();

    expect(stale).toEqual([]);
    expect(db.prepare(READ_ACTIVE_SLOT_SQL).all()).toEqual([
      { active: "b", build_id: "build-1", flipped_at: "2026-10-03T06:00:00Z" },
    ]);
  });
});

describe("slots", () => {
  test("each slot's other is the one a refresh builds into", () => {
    expect([otherSlot("a"), otherSlot("b")]).toEqual(["b", "a"]);
  });
});
