import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";

const CLI = fileURLToPath(new URL("./migrate-cli.ts", import.meta.url));

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "migrate-cli-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function migrate(url: string) {
  return promisify(execFile)(process.execPath, [CLI], {
    env: { ...process.env, TURSO_APP_DB_URL: url },
  });
}

test("migrates the database TURSO_APP_DB_URL names, then reports it current", async () => {
  const url = pathToFileURL(join(dir, "app.db")).href;

  expect((await migrate(url)).stdout).toContain(
    "applied 0004_served_database.sql",
  );
  expect((await migrate(url)).stdout).toBe("app database is current\n");
});

test("leaves a local file in WAL mode", async () => {
  const path = join(dir, "app.db");
  await migrate(pathToFileURL(path).href);

  const db = new DatabaseSync(path);
  const mode = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
  db.close();
  expect(mode).toBe("wal");
});
