import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { appDbClient, dataDbClient } from "./node.ts";

/** Holds a write lock on the file at `path` for `ms`, from another process. */
const HOLD_WRITE_LOCK = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE; INSERT INTO t VALUES (1);");
console.log("locked");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, Number(process.argv[2]));
`;

describe("appDbClient", () => {
  test("refuses an env without the app database url", () => {
    expect(() => appDbClient({})).toThrow("TURSO_APP_DB_URL is not set");
  });

  test("refuses a remote url without its token", () => {
    expect(() =>
      appDbClient({ TURSO_APP_DB_URL: "libsql://app-org.turso.io" }),
    ).toThrow("TURSO_APP_DB_TOKEN is not set");
  });

  test("accepts a loopback http url (turso dev) without a token", () => {
    for (const url of ["http://127.0.0.1:8080", "http://localhost:8080"]) {
      appDbClient({ TURSO_APP_DB_URL: url }).close();
    }
  });

  test("a local client waits out another process's write lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "busy-"));
    const path = join(dir, "app.db");
    const holder = spawn(
      process.execPath,
      ["-e", HOLD_WRITE_LOCK, path, "300"],
      {
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    try {
      await once(holder.stdout, "data");
      const app = appDbClient({ TURSO_APP_DB_URL: pathToFileURL(path).href });
      await app.execute("INSERT INTO t VALUES (2)");
      const rs = await app.execute("SELECT id FROM t ORDER BY id");
      app.close();

      expect(rs.rows.map((r) => r.id)).toStrictEqual([1, 2]);
    } finally {
      holder.kill();
      await rm(dir, { recursive: true, force: true });
    }
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
