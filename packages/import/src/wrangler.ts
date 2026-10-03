import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, execFile } from "node:child_process";
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

/**
 * How long one `--command` may take before it is killed: D1 stops a query at
 * 30 s, so this covers wrangler's start-up, its retries and local counts over
 * millions of rows many times over.
 */
export const QUERY_TIMEOUT_MS = 10 * 60_000;
/**
 * How long one `--file` may take before it is killed: the largest load, the
 * full e-file run (~450 MB of SQL), took minutes locally and has no remote
 * measurement yet; the monthly job has 6 h for everything.
 */
export const APPLY_TIMEOUT_MS = 2 * 60 * 60_000;

/** The wrangler processes running now, for `stopWrangler`. */
const running = new Set<ChildProcess>();
const stopped = new WeakSet<ChildProcess>();
/** Set by `stopWrangler`: from then on only its cleanup may start wrangler. */
let halted = false;
const cleanup = new AsyncLocalStorage<true>();

/**
 * Runs wrangler against the worker's config; resolves with stdout, rejects
 * with wrangler's own output, or once `timeoutMs` passes, killing it.
 */
export function wrangler(
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  const what = `wrangler ${args.slice(0, 2).join(" ")}`;
  if (halted && cleanup.getStore() === undefined) {
    return Promise.reject(new Error(`${what} stopped`));
  }
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = execFile(
      process.execPath,
      [WRANGLER_BIN, ...args, "--config", WORKER_CONFIG],
      {
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        running.delete(child);
        // checked before the exit status: wrangler exits 0 on the SIGTERM that kills it
        if (stopped.has(child)) {
          reject(new Error(`${what} stopped`, { cause: error }));
        } else if (timedOut) {
          reject(
            new Error(`${what} timed out after ${timeoutMs} ms`, {
              cause: error,
            }),
          );
        } else if (error !== null) {
          reject(
            new Error(`${what} failed:\n${stderr || stdout}`, { cause: error }),
          );
        } else {
          resolve(stdout);
        }
      },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    running.add(child);
  });
}

/**
 * Kills every wrangler process running now (each one's call rejects as
 * stopped), refuses every later call but `then`'s, and once the killed ones
 * have exited, runs `then`: so a cleanup never races the run it stopped for
 * the same database.
 */
export async function stopWrangler<T>(then: () => Promise<T>): Promise<T> {
  halted = true;
  const exited = [...running].map(
    (child) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("exit", () => resolve());
      }),
  );
  for (const child of running) {
    stopped.add(child);
    child.kill("SIGTERM");
  }
  await Promise.all(exited);
  return cleanup.run(true, then);
}

/** Runs SQL files and queries through `wrangler d1 execute`, against local D1 state or the remote databases. */
export interface D1Ops {
  /** The deployed databases, not local state. */
  readonly remote: boolean;
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
  return wranglerD1(false, [
    "--local",
    ...(persistTo === undefined ? [] : ["--persist-to", persistTo]),
  ]);
}

/** The remote databases the worker's config names. */
export function remoteD1(): D1Ops {
  return wranglerD1(true, ["--remote", "--yes"]);
}

function wranglerD1(remote: boolean, where: readonly string[]): D1Ops {
  return {
    remote,
    async applyFile(binding, file) {
      await wrangler(
        ["d1", "execute", binding, ...where, "--file", file],
        APPLY_TIMEOUT_MS,
      );
    },
    async query<T>(binding: DataDbBinding | "APP_DB", sql: string) {
      const out = await wrangler(
        ["d1", "execute", binding, ...where, "--json", "--command", sql],
        QUERY_TIMEOUT_MS,
      );
      const results = JSON.parse(out) as { results: T[] }[];
      return results.at(-1)?.results ?? [];
    },
  };
}
