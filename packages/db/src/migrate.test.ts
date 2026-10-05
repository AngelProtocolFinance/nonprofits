import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Client, createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { migrateAppDb } from "./node.ts";

let dir: string;
let app: Client;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "app-db-"));
  app = createClient({ url: pathToFileURL(join(dir, "app.db")).href });
});

afterEach(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("migrateAppDb", () => {
  test("applies every app migration in order to a fresh database", async () => {
    expect(await migrateAppDb(app)).toEqual([
      "0001_better_auth.sql",
      "0002_key_limits_and_usage.sql",
      "0004_served_database.sql",
    ]);
    const tables = await app.execute(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('apikey', 'key_usage', 'served_database')",
    );
    expect(tables.rows.map((r) => r.name).sort()).toEqual([
      "apikey",
      "key_usage",
      "served_database",
    ]);
  });

  test("a second run applies nothing", async () => {
    await migrateAppDb(app);
    expect(await migrateAppDb(app)).toEqual([]);
  });

  test("a failing file leaves nothing of itself and is retried next run", async () => {
    const migrations = join(dir, "migrations");
    await mkdir(migrations);
    await writeFile(
      join(migrations, "0001_ok.sql"),
      "CREATE TABLE ok (id INTEGER PRIMARY KEY);",
    );
    await writeFile(
      join(migrations, "0002_half.sql"),
      "CREATE TABLE half (id INTEGER PRIMARY KEY);\nINSERT INTO missing VALUES (1);",
    );
    const dirUrl = pathToFileURL(`${migrations}/`);

    await expect(migrateAppDb(app, dirUrl)).rejects.toThrow(/missing/);
    const tables = await app.execute(
      "SELECT name FROM sqlite_schema WHERE name IN ('ok', 'half')",
    );
    expect(tables.rows.map((r) => r.name)).toEqual(["ok"]);

    await writeFile(
      join(migrations, "0002_half.sql"),
      "CREATE TABLE half (id INTEGER PRIMARY KEY);",
    );
    expect(await migrateAppDb(app, dirUrl)).toEqual(["0002_half.sql"]);
  });
});
