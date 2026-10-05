import { createClient } from "@libsql/client";
import { afterEach, describe, expect, test } from "vitest";
import { dataDbFixture, type LocalDb } from "./fixture.ts";
import { createDataDatabase, holdsBuild, readDataMeta } from "./index.ts";

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
