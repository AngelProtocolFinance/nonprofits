import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DataDbBinding } from "@nonprofits/db";

// wrangler's exports map hides bin/, so resolve the manifest beside it
const WRANGLER_BIN = fileURLToPath(
  new URL(
    "bin/wrangler.js",
    pathToFileURL(
      createRequire(import.meta.url).resolve("wrangler/package.json"),
    ),
  ),
);
/** The worker's config owns the D1 bindings. */
const WORKER_CONFIG = fileURLToPath(
  new URL("../../worker/wrangler.jsonc", import.meta.url),
);

/** Runs wrangler against the worker's config; resolves with stdout, rejects with wrangler's own output. */
export function wrangler(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [WRANGLER_BIN, ...args, "--config", WORKER_CONFIG],
      {
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `wrangler ${args.slice(0, 2).join(" ")} failed:\n${stderr || stdout}`,
              { cause: error },
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Runs SQL files and queries through `wrangler d1 execute`, against local D1 state or the remote databases. */
export interface D1Ops {
  /**
   * Runs `file` with `--file`, which D1 applies as one transaction. Remote, that
   * goes through D1's import API and blocks the database for the import, so only
   * a data database takes it: every request reads `APP_DB`.
   */
  applyFile(binding: DataDbBinding, file: string): Promise<void>;
  /** Runs `sql` with `--command`; resolves with the last statement's rows. */
  query<T>(binding: DataDbBinding | "APP_DB", sql: string): Promise<T[]>;
}

/** Where a load is applied: a data database, through `ops`. */
export interface D1Target {
  ops: D1Ops;
  binding: DataDbBinding;
}

/** Local D1 state, under wrangler's default dir unless `persistTo`. */
export function localD1(persistTo?: string): D1Ops {
  return wranglerD1([
    "--local",
    ...(persistTo === undefined ? [] : ["--persist-to", persistTo]),
  ]);
}

/** The remote databases the worker's config names. */
export function remoteD1(): D1Ops {
  return wranglerD1(["--remote", "--yes"]);
}

function wranglerD1(where: readonly string[]): D1Ops {
  return {
    async applyFile(binding, file) {
      await wrangler(["d1", "execute", binding, ...where, "--file", file]);
    },
    async query<T>(binding: DataDbBinding | "APP_DB", sql: string) {
      const out = await wrangler([
        "d1",
        "execute",
        binding,
        ...where,
        "--json",
        "--command",
        sql,
      ]);
      const results = JSON.parse(out) as { results: T[] }[];
      return results.at(-1)?.results ?? [];
    },
  };
}
