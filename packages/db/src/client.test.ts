import { describe, expect, test } from "vitest";
import { appDbClient, dataDbClient } from "./node.ts";

describe("appDbClient", () => {
  test("refuses an env without the app database url", () => {
    expect(() => appDbClient({})).toThrow("TURSO_APP_DB_URL is not set");
  });

  test("refuses a remote url without its token", () => {
    expect(() =>
      appDbClient({ TURSO_APP_DB_URL: "libsql://app-org.turso.io" }),
    ).toThrow("TURSO_APP_DB_TOKEN is not set");
  });

  test("opens a local file without a token", async () => {
    const app = appDbClient({ TURSO_APP_DB_URL: "file::memory:" });
    expect((await app.execute("SELECT 1 AS one")).rows[0]?.one).toBe(1);
    app.close();
  });
});

describe("dataDbClient", () => {
  test("refuses a remote url without the group token", () => {
    expect(() => dataDbClient("libsql://data-org.turso.io", {})).toThrow(
      "TURSO_DATA_DB_TOKEN is not set",
    );
  });
});
