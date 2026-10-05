import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { appDbFixture, type LocalDb } from "./fixture.ts";
import {
  NEVER_BUILT,
  readServedDatabase,
  switchServedDatabase,
} from "./index.ts";

let app: LocalDb;

beforeEach(async () => {
  app = await appDbFixture();
});

afterEach(async () => {
  await app.dispose();
});

describe("readServedDatabase", () => {
  test("a fresh app database serves nothing yet", async () => {
    expect(await readServedDatabase(app.client)).toStrictEqual({
      database: null,
      build_id: NEVER_BUILT,
      switched_at: "1970-01-01T00:00:00Z",
    });
  });
});

const SEPTEMBER = {
  name: "nonprofits-20260910",
  url: "libsql://nonprofits-20260910-org.turso.io",
};
const OCTOBER = {
  name: "nonprofits-20261010",
  url: "libsql://nonprofits-20261010-org.turso.io",
};

/** Now, to the second, as the database stamps it. */
function isoSecondsNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

describe("switchServedDatabase", () => {
  test("from the database served now, switches and stamps the time", async () => {
    const before = isoSecondsNow();
    const result = await switchServedDatabase(app.client, {
      expected: null,
      to: SEPTEMBER,
      buildId: "20260910T030000Z",
    });
    const after = isoSecondsNow();

    expect(result.switched).toBe(true);
    const pointer = await readServedDatabase(app.client);
    expect(result.pointer).toStrictEqual(pointer);
    expect(pointer).toMatchObject({
      database: SEPTEMBER,
      build_id: "20260910T030000Z",
    });
    expect(pointer.switched_at >= before && pointer.switched_at <= after).toBe(
      true,
    );
  });

  test("from a stale expected database, changes nothing and reports what is served", async () => {
    await switchServedDatabase(app.client, {
      expected: null,
      to: SEPTEMBER,
      buildId: "20260910T030000Z",
    });
    const served = await readServedDatabase(app.client);

    const raced = await switchServedDatabase(app.client, {
      expected: null,
      to: OCTOBER,
      buildId: "20261010T030000Z",
    });

    expect(raced).toStrictEqual({ switched: false, pointer: served });
    expect(await readServedDatabase(app.client)).toStrictEqual(served);
  });
});
