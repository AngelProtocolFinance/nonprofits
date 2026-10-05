import { createClient } from "@libsql/client";
import { afterEach, describe, expect, test } from "vitest";
import { dataDbFixture, type LocalDb } from "./fixture.ts";
import {
  createDataDatabase,
  readDataMeta,
  type ServedPointer,
  servesBuild,
} from "./index.ts";

const BUILD = "20260910T030000Z";

function pointerTo(buildId: string): ServedPointer {
  return {
    database: { name: "nonprofits-20260910", url: "libsql://x.turso.io" },
    build_id: buildId,
    switched_at: "2026-09-10T06:00:00Z",
  };
}

let data: LocalDb | undefined;

afterEach(async () => {
  await data?.dispose();
  data = undefined;
});

describe("servesBuild", () => {
  test("a finished database serves the build the pointer names, and no other", async () => {
    data = await dataDbFixture(BUILD);
    const meta = await readDataMeta(data.client);

    expect(meta?.build_id).toBe(BUILD);
    expect(servesBuild(pointerTo(BUILD), meta)).toBe(true);
    expect(servesBuild(pointerTo("20261010T030000Z"), meta)).toBe(false);
  });

  test("an unfinished database is never served", async () => {
    const unfinished = createClient({ url: ":memory:" });
    await createDataDatabase(unfinished);
    const meta = await readDataMeta(unfinished);
    unfinished.close();

    expect(meta).toBeUndefined();
    expect(servesBuild(pointerTo(BUILD), meta)).toBe(false);
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
