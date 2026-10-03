import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import {
  claimSlotSql,
  fenceSql,
  flipActiveSlotSql,
  isServable,
  NEVER_BUILT,
  otherSlot,
  READ_ACTIVE_SLOT_SQL,
  READ_CLAIM_SQL,
  READ_DATA_META_SQL,
  rebuildSearchIndexSql,
  releaseClaimSql,
  resetGenerationSql,
  sealGenerationSql,
} from "./index.ts";
import { DATA_TABLES } from "./schema.ts";

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
    "INSERT OR REPLACE INTO data_meta (id, slot, build_id, state) VALUES (1, 'a', 'build-x', 'building')",
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

  test("keeps its search index whole through a rebuild", () => {
    const db = dataDb();
    db.exec(resetGenerationSql("a", "build-1"));
    db.exec(FILL);
    db.exec(rebuildSearchIndexSql("build-1"));
    db.prepare(sealGenerationSql("build-1")).all();

    db.exec(rebuildSearchIndexSql("build-2"));

    expect(
      db
        .prepare("SELECT rowid FROM orgs_fts WHERE orgs_fts MATCH 'red cross'")
        .all(),
    ).toEqual([{ rowid: 530196605 }]);
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

describe("fenceSql", () => {
  const LOAD = "INSERT INTO orgs (ein) VALUES ('131624100');";

  function orgCount(db: DatabaseSync): number {
    return (db.prepare("SELECT count(*) AS n FROM orgs").get() as { n: number })
      .n;
  }

  test("lets a load through into the slot its build is filling", () => {
    const db = dataDb();
    db.exec(resetGenerationSql("b", "build-1"));

    db.exec(`${fenceSql("build-1")}\n${LOAD}`);

    expect(orgCount(db)).toBe(1);
    expect(db.prepare(READ_DATA_META_SQL).all()).toEqual([
      { slot: "b", build_id: "build-1", state: "building" },
    ]);
  });

  test("aborts a load whose slot a newer build has reset, before it writes", () => {
    const db = dataDb();
    db.exec(resetGenerationSql("b", "build-2"));

    expect(() => db.exec(`${fenceSql("build-1")}\n${LOAD}`)).toThrow(
      "load refused: this slot is not building the load's build",
    );
    expect(orgCount(db)).toBe(0);
  });

  test("aborts a load into its own build's generation once sealed", () => {
    const db = dataDb();
    db.exec(resetGenerationSql("b", "build-1"));
    db.prepare(sealGenerationSql("build-1")).all();

    expect(() => db.exec(`${fenceSql("build-1")}\n${LOAD}`)).toThrow();
    expect(orgCount(db)).toBe(0);
  });

  test("aborts a load into a database no reset has made a generation", () => {
    const db = dataDb();

    expect(() => db.exec(fenceSql("build-1"))).toThrow("no such table");
  });

  test("is one line, so a `;`-at-line-end splitter keeps it whole", () => {
    expect(fenceSql("build-1").trimEnd().split("\n")).toHaveLength(1);
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

  test.each([
    "UPDATE data_generation SET flipped_at = 'yesterday'",
    "UPDATE data_generation SET claim_slot = 'b', claim_build_id = 'x', claimed_at = 'soon', claim_expires_at = '2026-10-03T13:00:00Z'",
    "UPDATE data_generation SET claim_slot = 'b', claim_build_id = 'x', claimed_at = '2026-10-03T05:00:00Z', claim_expires_at = 'in 8 h'",
  ])("refuses a time SQLite can't read: %s", async (sql) => {
    const db = await appDb();

    expect(() => db.exec(sql)).toThrow("CHECK constraint failed");
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

/** An ISO timestamp, to the second, within 5 s of this machine's clock: the database's own `now`. */
function expectDatabaseNow(iso: unknown): void {
  expect(iso).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  expect(Math.abs(Date.parse(iso as string) - Date.now())).toBeLessThan(5_000);
}

/** Moves `column` of the pointer row `seconds` before the database's clock, as time passing would. */
function backdate(db: DatabaseSync, column: string, seconds: number): void {
  db.exec(
    `UPDATE data_generation SET ${column} = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-${seconds} seconds')`,
  );
}

// a runner's clock past the 8 h lease and the settle: only the database's clock can refuse
const NINE_HOURS_AHEAD = new Date(Date.now() + 9 * 3600_000).toISOString();

describe("claimSlotSql", () => {
  test("claims the inactive slot for a build, stamped by the database's clock, for an 8 h lease", async () => {
    const db = await appDb();

    const [claimed] = db.prepare(claimSlotSql("b", "build-1")).all() as {
      claim_slot: string;
      claim_build_id: string;
      claimed_at: string;
      claim_expires_at: string;
    }[];

    expect(claimed).toMatchObject({
      claim_slot: "b",
      claim_build_id: "build-1",
    });
    expectDatabaseNow(claimed?.claimed_at);
    expect(
      Date.parse(claimed?.claim_expires_at ?? "") -
        Date.parse(claimed?.claimed_at ?? ""),
    ).toBe(8 * 3600_000);
  });

  test("refuses the active slot", async () => {
    const db = await appDb();

    expect(db.prepare(claimSlotSql("a", "build-1")).all()).toEqual([]);
    expect(claimOf(db)).toEqual(NO_CLAIM);
  });

  test("refuses while another build's lease runs, whatever the claiming runner's clock says", async () => {
    const db = await appDb();
    db.prepare(claimSlotSql("b", "build-1")).all();

    const skewed = db
      .prepare(claimSlotSql("b", "build-2", NINE_HOURS_AHEAD))
      .all();

    expect(skewed).toEqual([]);
    expect(claimOf(db)).toMatchObject({ claim_build_id: "build-1" });
  });

  test("claims once another build's lease has run out by the database's clock", async () => {
    const db = await appDb();
    db.prepare(claimSlotSql("b", "build-1", undefined, 3600)).all();
    backdate(db, "claim_expires_at", 1);

    expect(db.prepare(claimSlotSql("b", "build-2")).all()).toMatchObject([
      { claim_build_id: "build-2" },
    ]);
  });
});

describe("claimSlotSql after a flip", () => {
  /** An app DB whose last flip, to b, was `secondsAgo` before the database's own clock. */
  async function flippedAgo(secondsAgo: number): Promise<DatabaseSync> {
    const db = await appDb();
    db.prepare(claimSlotSql("b", "build-1")).all();
    db.prepare(flipActiveSlotSql("a", "build-1")).all();
    backdate(db, "flipped_at", secondsAgo);
    return db;
  }

  test("refuses the slot the flip left while Workers may still serve it", async () => {
    const db = await flippedAgo(50);

    expect(
      db.prepare(claimSlotSql("a", "build-2", NINE_HOURS_AHEAD)).all(),
    ).toEqual([]);
  });

  test("claims the slot the flip left once 60 s have passed", async () => {
    const db = await flippedAgo(70);

    expect(db.prepare(claimSlotSql("a", "build-2")).all()).toMatchObject([
      { claim_slot: "a", claim_build_id: "build-2" },
    ]);
  });
});

describe("releaseClaimSql", () => {
  test("frees the claim only for the build holding it", async () => {
    const db = await appDb();
    db.prepare(claimSlotSql("b", "build-1")).all();

    const other = db.prepare(releaseClaimSql("build-2")).all();
    const own = db.prepare(releaseClaimSql("build-1")).all();

    expect(other).toEqual([]);
    expect(own).toEqual([{ released_build_id: "build-1" }]);
    expect(claimOf(db)).toEqual(NO_CLAIM);
  });
});

describe("flipActiveSlotSql", () => {
  test("flips to the slot the build claimed, stamped by the database's clock, and clears the claim", async () => {
    const db = await appDb();
    db.prepare(claimSlotSql("b", "build-1")).all();

    const [flipped] = db
      .prepare(flipActiveSlotSql("a", "build-1", "2000-01-01T00:00:00Z"))
      .all() as { active: string; build_id: string; flipped_at: string }[];

    expect(flipped).toMatchObject({ active: "b", build_id: "build-1" });
    expectDatabaseNow(flipped?.flipped_at);
    expect(db.prepare(READ_ACTIVE_SLOT_SQL).all()).toEqual([flipped]);
    expect(claimOf(db)).toEqual(NO_CLAIM);
  });

  test("refuses a build that holds no claim", async () => {
    const db = await appDb();
    const unclaimed = db.prepare(flipActiveSlotSql("a", "build-1")).all();
    db.prepare(claimSlotSql("b", "build-2")).all();

    const anothers = db.prepare(flipActiveSlotSql("a", "build-1")).all();

    expect([unclaimed, anothers]).toEqual([[], []]);
    expect(db.prepare(READ_ACTIVE_SLOT_SQL).all()).toEqual([
      { active: "a", build_id: "empty", flipped_at: "1970-01-01T00:00:00Z" },
    ]);
  });

  test("refuses a flip from a slot that is no longer active", async () => {
    const db = await appDb();
    db.prepare(claimSlotSql("b", "build-1")).all();
    db.prepare(flipActiveSlotSql("a", "build-1")).all();
    backdate(db, "flipped_at", 70);
    db.prepare(claimSlotSql("a", "build-2")).all();

    const stale = db.prepare(flipActiveSlotSql("a", "build-2")).all();

    expect(stale).toEqual([]);
    expect(db.prepare(READ_ACTIVE_SLOT_SQL).all()).toMatchObject([
      { active: "b", build_id: "build-1" },
    ]);
  });
});

describe("isServable", () => {
  const POINTER = {
    active: "b",
    build_id: "build-1",
    flipped_at: "2026-10-03T06:00:00Z",
  } as const;

  test("serves the slot the pointer names once its data_meta is that slot, sealed for the pointer's build", () => {
    expect(
      isServable(POINTER, {
        slot: "b",
        build_id: "build-1",
        state: "complete",
      }),
    ).toBe(true);
  });

  test.each([
    ["no data_meta row", undefined],
    [
      "another slot's data_meta",
      { slot: "a", build_id: "build-1", state: "complete" },
    ],
    ["another build", { slot: "b", build_id: "build-2", state: "complete" }],
    [
      "a build still loading",
      { slot: "b", build_id: "build-1", state: "building" },
    ],
  ] as const)("refuses %s", (_, meta) => {
    expect(isServable(POINTER, meta)).toBe(false);
  });
});

describe("the protocol's reads", () => {
  test("a fresh app DB's pointer names the never-built build and no claim", async () => {
    const db = await appDb();

    expect(db.prepare(READ_ACTIVE_SLOT_SQL).get()).toMatchObject({
      build_id: NEVER_BUILT,
    });
    expect(db.prepare(READ_CLAIM_SQL).all()).toEqual([NO_CLAIM]);
  });
});

describe("slots", () => {
  test("each slot's other is the one a refresh builds into", () => {
    expect([otherSlot("a"), otherSlot("b")]).toEqual(["b", "a"]);
  });
});
