import { createClient } from "@libsql/client";
import { afterEach, describe, expect, test } from "vitest";
import { dataDbFixture, type LocalDb } from "./fixture.ts";
import {
  createDataDatabase,
  holdsBuild,
  readDataCounts,
  readDataMeta,
  recordCounts,
} from "./index.ts";

const BUILD = "20260910T030000Z";

let data: LocalDb | undefined;

afterEach(async () => {
  await data?.dispose();
  data = undefined;
});

describe("holdsBuild", () => {
  test("a finished database holds its own build, and no other", async () => {
    data = await dataDbFixture(BUILD);
    const meta = await readDataMeta(data.client);

    expect(meta?.build_id).toBe(BUILD);
    expect(holdsBuild(BUILD, meta)).toBe(true);
    expect(holdsBuild("20261010T030000Z", meta)).toBe(false);
  });

  test("an unfinished database holds no build", async () => {
    const unfinished = createClient({ url: ":memory:" });
    await createDataDatabase(unfinished);
    const meta = await readDataMeta(unfinished);
    unfinished.close();

    expect(meta).toBeUndefined();
    expect(holdsBuild(BUILD, meta)).toBe(false);
  });
});

describe("finishDataDatabase", () => {
  test("indexes org names for search", async () => {
    data = await dataDbFixture(BUILD);
    const rs = await data.client.execute({
      sql: "SELECT rowid FROM orgs_fts WHERE orgs_fts MATCH ?",
      args: ["red cross"],
    });

    expect(rs.rows.map((r) => r.rowid)).toStrictEqual([530196605]);
  });
});

describe("readDataCounts", () => {
  test("reads back the counts a finished build recorded", async () => {
    data = await dataDbFixture(BUILD);
    await recordCounts(data.client, { orgs: 3_275_963, in_pub78: 1_419_989 });

    expect(await readDataCounts(data.client)).toStrictEqual({
      orgs: 3_275_963,
      in_pub78: 1_419_989,
    });
  });

  test("a finished build that recorded none reads none", async () => {
    data = await dataDbFixture(BUILD);

    expect(await readDataCounts(data.client)).toBeUndefined();
  });

  test("a database whose data_meta predates recorded counts reads none", async () => {
    const older = createClient({ url: ":memory:" });
    await older.executeMultiple(`
      CREATE TABLE data_meta (id INTEGER PRIMARY KEY, build_id TEXT NOT NULL, built_at TEXT NOT NULL) STRICT;
      INSERT INTO data_meta VALUES (1, '${BUILD}', '2026-09-10T03:00:00Z');
    `);
    const counts = await readDataCounts(older);
    older.close();

    expect(counts).toBeUndefined();
  });

  test("an unfinished database can't record counts", async () => {
    const unfinished = createClient({ url: ":memory:" });
    await createDataDatabase(unfinished);
    const recording = recordCounts(unfinished, { orgs: 1 });
    await expect(recording).rejects.toThrow("unfinished");
    unfinished.close();
  });
});
