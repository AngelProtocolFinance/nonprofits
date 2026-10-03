import { readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { DATA_DB_BINDING, resetGenerationSql } from "@nonprofits/db";
import type { DownloadRetry } from "./load.ts";
import {
  type D1Target,
  localD1,
  QUERY_TIMEOUT_MS,
  type WranglerRun,
  wrangler,
} from "./wrangler.ts";

/** Retries at once, at most twice more, giving up on a body silent for 500 ms; records each retry's line. */
export function quickRetry(): DownloadRetry & { lines: string[] } {
  const lines: string[] = [];
  return {
    attempts: 3,
    firstDelayMs: 1,
    maxDelayMs: 1,
    stallMs: 500,
    log: (line) => lines.push(line),
    lines,
  };
}

/** A body with the Last-Modified it is served under: its own date, or none at all for `null`. */
export interface DatedBody {
  body: string | Uint8Array;
  lastModified: string | null;
}

/** A body served whole under `serve`'s date, one with its own date, or a handler that writes the response itself. */
export type Route =
  | string
  | Uint8Array
  | DatedBody
  | ((res: ServerResponse) => void);

/** Serves `routes` over loopback, each body but a `DatedBody` with `lastModified` as its Last-Modified. */
export async function serve(
  routes: Map<string, Route>,
  lastModified: string,
): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const route = routes.get(req.url ?? "");
    if (route === undefined) {
      res.writeHead(404).end();
    } else if (typeof route === "function") {
      route(res);
    } else {
      const dated =
        typeof route === "string" || route instanceof Uint8Array
          ? { body: route, lastModified }
          : route;
      res
        .writeHead(
          200,
          dated.lastModified === null
            ? {}
            : { "last-modified": dated.lastModified },
        )
        .end(dated.body);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

/** The build `resetDataDb` leaves building. */
const TEST_BUILD = "test";

/** The local data DB under `persistTo` that the load tests apply to. */
export function loadTarget(persistTo: string): D1Target {
  return {
    ops: localD1(persistTo),
    binding: DATA_DB_BINDING.a,
    buildId: TEST_BUILD,
  };
}

/** Builds an empty data generation in the local load DB under `persistTo`. */
export async function resetDataDb(persistTo: string): Promise<void> {
  await mkdir(persistTo, { recursive: true });
  const file = join(persistTo, "reset-generation.sql");
  await writeFile(file, resetGenerationSql("a", TEST_BUILD));
  const { ops, binding } = loadTarget(persistTo);
  await ops.applyFile(binding, file);
}

/** Runs `sql` against the local load DB under `persistTo`; resolves with the last statement's rows. */
export function query<T>(persistTo: string, sql: string): Promise<T[]> {
  const { ops, binding } = loadTarget(persistTo);
  return ops.query<T>(binding, sql);
}

/** Applies the app migrations to the local `APP_DB` under `persistTo`, seeding the pointer at slot a, build `empty`. */
export async function migrateAppDb(persistTo: string): Promise<void> {
  await wrangler(
    [
      "d1",
      "migrations",
      "apply",
      "APP_DB",
      "--local",
      "--persist-to",
      persistTo,
    ],
    QUERY_TIMEOUT_MS,
  );
}

const APP_MIGRATIONS = fileURLToPath(
  new URL("../../db/migrations/app/", import.meta.url),
);

/** The value after `flag` in `args`. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

/**
 * A wrangler that runs `d1 execute` on in-memory SQLite instead of a child
 * process: one database per binding, `APP_DB` with its migrations applied and
 * a data database empty until a reset file is applied. Answers as `wrangler
 * d1 execute --json` does (one result set per `--command`), applies a `--file`
 * as one transaction as D1 does, and fails as wrangler would. Every call to
 * one runner shares its databases; make a runner per test for state of its own.
 */
export function sqliteWrangler(): WranglerRun {
  const dbs = new Map<string, DatabaseSync>();
  const open = (binding: string): DatabaseSync => {
    let db = dbs.get(binding);
    if (db === undefined) {
      db = new DatabaseSync(":memory:");
      if (binding === "APP_DB") {
        for (const name of readdirSync(APP_MIGRATIONS).sort()) {
          if (name.endsWith(".sql")) {
            db.exec(readFileSync(join(APP_MIGRATIONS, name), "utf8"));
          }
        }
      }
      dbs.set(binding, db);
    }
    return db;
  };
  return async (args) => {
    const db = open(args[2] ?? "");
    const file = flagValue(args, "--file");
    const command = flagValue(args, "--command");
    try {
      if (file !== undefined) {
        db.exec("BEGIN");
        try {
          db.exec(readFileSync(file, "utf8"));
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return "applied";
      }
      if (command === undefined) throw new Error("no --file or --command");
      const statement = db.prepare(command);
      let results: unknown[] = [];
      if (statement.columns().length > 0) results = statement.all();
      else statement.run();
      return JSON.stringify([{ results, success: true, meta: {} }]);
    } catch (error) {
      throw new Error(
        `wrangler d1 execute failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };
}
