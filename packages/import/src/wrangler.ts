import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DataDbBinding } from "@nonprofits/db";
import { RETRY, type RetryPolicy, retrying } from "./retry.ts";

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

/** The wrangler processes running now, with their args, for `stopWrangler`. */
const running = new Map<ChildProcess, readonly string[]>();
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
            new Error(`${what} failed:${failureOutput(stdout, stderr)}`, {
              cause: error,
            }),
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
    running.set(child, args);
  });
}

/**
 * What a failed command printed: with `--json`, the error is JSON on stdout,
 * so its text leads, then stderr and stdout whole, as a warning on stderr
 * would otherwise hide it.
 */
function failureOutput(stdout: string, stderr: string): string {
  const both = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  const json = jsonErrorText(stdout);
  return json === undefined ? `\n${both}` : ` ${json}\n${both}`;
}

function jsonErrorText(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { error?: { text?: unknown } } | null;
    const text = parsed?.error?.text;
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Kills every wrangler process running now (each one's call rejects as
 * stopped), refuses every later call but `then`'s, and once the killed ones
 * have exited, runs `then` with their args: so a cleanup never races the run
 * it stopped for the same database, and knows what it cut short.
 */
export async function stopWrangler<T>(
  then: (killed: readonly (readonly string[])[]) => Promise<T>,
): Promise<T> {
  halted = true;
  const killed = [...running.values()];
  const exited = [...running.keys()].map(
    (child) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("exit", () => resolve());
      }),
  );
  for (const child of running.keys()) {
    stopped.add(child);
    child.kill("SIGTERM");
  }
  await Promise.all(exited);
  return cleanup.run(true, () => then(killed));
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
  /**
   * Runs `sql` with `--command`; resolves with the last statement's rows. A
   * single `SELECT` that fails transiently (a dropped connection, an API 5xx,
   * a timeout) is tried again; anything else, which may have written, never is.
   */
  query<T>(binding: DataDbBinding | "APP_DB", sql: string): Promise<T[]>;
}

/**
 * A remote `--file` that failed with D1's import perhaps still running: the
 * command was killed (timed out or stopped) or lost touch with the API while
 * polling, and killing wrangler doesn't stop an import D1 has begun.
 */
export class ImportMayBeRunning extends Error {
  readonly binding: DataDbBinding;

  constructor(binding: DataDbBinding, cause: Error) {
    super(cause.message, { cause });
    this.binding = binding;
  }
}

/** Where a load is applied: a data database, through `ops`. */
export interface D1Target {
  ops: D1Ops;
  binding: DataDbBinding;
  /** The build the database is `building`: each load file opens with its fence, so it writes nothing into any other. */
  buildId: string;
}

/** Runs one wrangler command, as `wrangler` does. */
export type WranglerRun = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>;

export interface WranglerD1Options {
  /** Defaults to `wrangler`. */
  run?: WranglerRun;
  /** For reads; defaults to `RETRY`. */
  retry?: RetryPolicy;
}

/** Local D1 state, under wrangler's default dir unless `persistTo`. */
export function localD1(
  persistTo?: string,
  options: WranglerD1Options = {},
): D1Ops {
  return wranglerD1(
    false,
    [
      "--local",
      ...(persistTo === undefined ? [] : ["--persist-to", persistTo]),
    ],
    options,
  );
}

/** The remote databases the worker's config names. */
export function remoteD1(options: WranglerD1Options = {}): D1Ops {
  return wranglerD1(true, ["--remote", "--yes"], options);
}

function wranglerD1(
  remote: boolean,
  where: readonly string[],
  { run = wrangler, retry = RETRY }: WranglerD1Options,
): D1Ops {
  return {
    remote,
    async applyFile(binding, file) {
      try {
        await run(
          ["d1", "execute", binding, ...where, "--file", file],
          APPLY_TIMEOUT_MS,
        );
      } catch (error) {
        if (remote && importMayOutlive(error)) {
          throw new ImportMayBeRunning(binding, error);
        }
        throw error;
      }
    },
    async query<T>(binding: DataDbBinding | "APP_DB", sql: string) {
      const args = [
        "d1",
        "execute",
        binding,
        ...where,
        "--json",
        "--command",
        sql,
      ];
      const out = isSingleSelect(sql)
        ? await retrying(
            `wrangler d1 execute ${binding}`,
            retry,
            () => run(args, QUERY_TIMEOUT_MS),
            isTransientFailure,
          )
        : await run(args, QUERY_TIMEOUT_MS);
      const results = JSON.parse(out) as { results?: T[] }[];
      const last = results.at(-1)?.results;
      if (last === undefined) {
        throw new Error(
          `wrangler d1 execute ${binding} returned no result set: ${out}`,
        );
      }
      return last;
    },
  };
}

/** One statement that can only read: no other statement follows its `SELECT`. */
function isSingleSelect(sql: string): boolean {
  const statement = sql.trim().replace(/;$/, "");
  return /^SELECT\b/i.test(statement) && !statement.includes(";");
}

/**
 * What wrangler prints when the network, the Cloudflare API or D1 itself
 * failed rather than the statement; and `wrangler`'s own timeout.
 */
const TRANSIENT_OUTPUT =
  /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network connection lost|overloaded|too many requests|internal error|service unavailable|bad gateway|gateway time-?out|\b(?:status|HTTP) ?(?:429|5\d\d)\b| timed out after /i;

/**
 * Whether a failed remote `--file` may have left its import running: wrangler
 * was killed, or lost the network or an API request, which may have been a
 * poll. An import that failed on its own SQL has ended.
 */
function importMayOutlive(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message.endsWith(" stopped") ||
      error.message.includes("A request to the Cloudflare API") ||
      TRANSIENT_OUTPUT.test(error.message))
  );
}

function isTransientFailure(error: unknown): boolean {
  return error instanceof Error && TRANSIENT_OUTPUT.test(error.message);
}
