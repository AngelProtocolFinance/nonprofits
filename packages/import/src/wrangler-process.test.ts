import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";

/** The processes `wrangler` started, in order. */
const spawned = vi.hoisted(() => ({ children: [] as ChildProcess[] }));

// wrangler's own bin is swapped for fixtures/fake-wrangler.mjs, which does what $FAKE_WRANGLER says;
// everything the module does around the process (timer, kill, bookkeeping) runs as shipped
vi.mock(import("node:child_process"), async (importOriginal) => {
  const actual = await importOriginal();
  const fake = fileURLToPath(
    new URL("../fixtures/fake-wrangler.mjs", import.meta.url),
  );
  return {
    ...actual,
    execFile: ((file: string, args: string[], ...rest: unknown[]) => {
      const child = (actual.execFile as (...all: unknown[]) => ChildProcess)(
        file,
        [fake, ...args.slice(1)],
        ...rest,
      );
      spawned.children.push(child);
      return child;
    }) as typeof actual.execFile,
  };
});

/** `wrangler.ts` as a fresh module, so one test's stop never reaches another's. */
async function freshWrangler(): Promise<typeof import("./wrangler.ts")> {
  vi.resetModules();
  return import("./wrangler.ts");
}

/** What the fake does for the next command. */
function plan(what: {
  stdout?: string;
  stderr?: string;
  exit?: number;
  hang?: boolean;
  record?: string;
}): void {
  vi.stubEnv("FAKE_WRANGLER", JSON.stringify(what));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const WORKER_CONFIG = fileURLToPath(
  new URL("../../worker/wrangler.jsonc", import.meta.url),
);

let work: string;
let recorded: number;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "wrangler-process-"));
  recorded = 0;
});

afterAll(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

afterEach(() => {
  // a fake still running after its test is a kill the test did not prove
  for (const child of spawned.children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  spawned.children = [];
  vi.unstubAllEnvs();
});

/** What the fake saw: its args after the bin, and the metrics setting. */
async function seen(
  file: string,
): Promise<{ argv: string[]; metrics: string }> {
  return JSON.parse(await readFile(file, "utf8"));
}

function recording(): string {
  return join(work, `seen-${recorded++}.json`);
}

describe("remoteD1 through the wrangler process", () => {
  // `wrangler d1 execute --remote --json` over several statements, with the proxy warning wrangler prints on stderr
  const META = {
    served_by: "v3-prod",
    duration: 0.31,
    changes: 0,
    last_row_id: 0,
    changed_db: false,
    size_after: 1_146_880,
    rows_read: 3,
    rows_written: 0,
  };
  const SEVERAL_RESULT_SETS = JSON.stringify(
    [
      { results: [{ n: 1 }], success: true, meta: META },
      { results: [], success: true, meta: META },
      { results: [{ n: 2 }, { n: 3 }], success: true, meta: META },
    ],
    null,
    2,
  );
  const PROXY_WARNING =
    "▲ [WARNING] Proxy environment variables detected. We'll use your proxy for fetch requests.\n";

  test("a query runs the remote database as JSON against the worker's config, resolving with the last result set", async () => {
    const { remoteD1 } = await freshWrangler();
    const record = recording();
    plan({ stdout: SEVERAL_RESULT_SETS, stderr: PROXY_WARNING, record });

    const rows = await remoteD1().query("DATA_DB_B", "SELECT n FROM t");

    expect(rows).toStrictEqual([{ n: 2 }, { n: 3 }]);
    expect(await seen(record)).toStrictEqual({
      argv: [
        "d1",
        "execute",
        "DATA_DB_B",
        "--remote",
        "--yes",
        "--json",
        "--command",
        "SELECT n FROM t",
        "--config",
        WORKER_CONFIG,
      ],
      metrics: "false",
    });
  });

  test("an apply runs its file against the remote database, answering nothing", async () => {
    const { remoteD1 } = await freshWrangler();
    const record = recording();
    plan({ stdout: "🌀 Executing on remote database DATA_DB_A\n", record });

    await remoteD1().applyFile("DATA_DB_A", "/load/bmf.load.sql");

    expect((await seen(record)).argv).toStrictEqual([
      "d1",
      "execute",
      "DATA_DB_A",
      "--remote",
      "--yes",
      "--file",
      "/load/bmf.load.sql",
      "--config",
      WORKER_CONFIG,
    ]);
  });

  test("a statement D1 refused fails with the error text that leads the JSON, then wrangler's whole output", async () => {
    const { remoteD1 } = await freshWrangler();
    const error = JSON.stringify({
      error: {
        text: "no such table: nope: SQLITE_ERROR",
        notes: [{ text: "Error in D1 query" }],
      },
    });
    plan({ stdout: error, stderr: PROXY_WARNING, exit: 1 });

    const failure = remoteD1().query("APP_DB", "SELECT * FROM nope");

    await expect(failure).rejects.toThrow(
      `wrangler d1 execute failed: no such table: nope: SQLITE_ERROR\n${PROXY_WARNING.trim()}\n${error}`,
    );
  });

  test("a failure that printed no JSON error leads with wrangler's error line, then shows stderr and stdout", async () => {
    const { remoteD1 } = await freshWrangler();
    plan({
      stdout: "partial banner",
      stderr: `${PROXY_WARNING}\n✘ [ERROR] fetch failed\n`,
      exit: 1,
    });

    // a write, so it is not retried
    const failure = remoteD1().query("APP_DB", "DELETE FROM t");

    await expect(failure).rejects.toThrow(
      `wrangler d1 execute failed: ✘ [ERROR] fetch failed\n${PROXY_WARNING}\n✘ [ERROR] fetch failed\npartial banner`,
    );
  });

  test("a load file's failure, which wrangler prints in colour and without JSON, reads as plain text led by its cause", async () => {
    const { remoteD1 } = await freshWrangler();
    plan({
      stderr:
        "\n\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mA request to the Cloudflare API (/accounts/x/d1/database/y/import) failed.\u001b[0m\n",
      exit: 1,
    });

    const failure = remoteD1().applyFile("DATA_DB_A", "/load/bmf.load.sql");

    await expect(failure).rejects.toThrow(
      "wrangler d1 execute failed: ✘ [ERROR] A request to the Cloudflare API (/accounts/x/d1/database/y/import) failed.\n✘ [ERROR] A request",
    );
  });

  test("a failure whose JSON holds no error text leads with that output", async () => {
    const { remoteD1 } = await freshWrangler();
    plan({ stdout: JSON.stringify({ error: { code: 7500 } }), exit: 1 });

    const failure = remoteD1().query("APP_DB", "DELETE FROM t");

    await expect(failure).rejects.toThrow(
      'wrangler d1 execute failed: {"error":{"code":7500}}\n{"error":{"code":7500}}',
    );
  });

  test("a successful run's stderr warnings never reach the rows", async () => {
    const { remoteD1 } = await freshWrangler();
    plan({
      stdout: JSON.stringify([{ results: [{ n: 1 }], success: true }]),
      stderr: PROXY_WARNING,
    });

    expect(await remoteD1().query("APP_DB", "SELECT 1")).toStrictEqual([
      { n: 1 },
    ]);
  });
});

describe("a wrangler command that outlives its timeout", () => {
  test("is killed at the timeout, rejecting at once with the process gone", async () => {
    const { wrangler } = await freshWrangler();
    plan({ hang: true });
    const started = performance.now();

    await expect(wrangler(["d1", "execute", "APP_DB"], 300)).rejects.toThrow(
      "wrangler d1 execute timed out after 300 ms",
    );

    // the fake runs for a minute on its own
    expect(performance.now() - started).toBeLessThan(10_000);
    const [child] = spawned.children;
    expect(child?.signalCode ?? child?.exitCode).not.toBeNull();
    expect(isAlive(child?.pid ?? 0)).toBe(false);
  });

  test("does not stop the next command from running", async () => {
    const { wrangler } = await freshWrangler();
    plan({ hang: true });
    await expect(wrangler(["d1", "execute", "APP_DB"], 200)).rejects.toThrow(
      "timed out",
    );
    plan({ stdout: "ok" });

    expect(await wrangler(["d1", "execute", "APP_DB"], 30_000)).toBe("ok");
  });
});

describe("stopWrangler", () => {
  test("kills the running command, which rejects as stopped though it exits 0, then runs its cleanup alone", async () => {
    const { wrangler, stopWrangler } = await freshWrangler();
    plan({ hang: true });
    const running = wrangler(
      ["d1", "execute", "DATA_DB_A", "--file", "x.sql"],
      60_000,
    );
    const stopped = expect(running).rejects.toThrow(
      "wrangler d1 execute stopped",
    );
    // the fake must be up, its SIGTERM handler installed, before the stop
    await vi.waitFor(() => expect(spawned.children).toHaveLength(1));
    const [child] = spawned.children;
    await vi.waitFor(() => expect(child?.pid).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = performance.now();

    let killed: readonly (readonly string[])[] = [];
    let aliveInCleanup: boolean | undefined;
    const cleaned = await stopWrangler(async (commands) => {
      killed = commands;
      aliveInCleanup = isAlive(child?.pid ?? 0);
      plan({ stdout: "cleaned" });
      return wrangler(["d1", "execute", "APP_DB"], 30_000);
    });

    await stopped;
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(child?.exitCode).toBe(0);
    expect(isAlive(child?.pid ?? 0)).toBe(false);
    // the cleanup begins once the killed command has exited
    expect(aliveInCleanup).toBe(false);
    expect(killed).toStrictEqual([
      ["d1", "execute", "DATA_DB_A", "--file", "x.sql"],
    ]);
    expect(cleaned).toBe("cleaned");
  });

  test("refuses every command outside its cleanup afterwards, starting no process", async () => {
    const { wrangler, stopWrangler } = await freshWrangler();
    await stopWrangler(async () => undefined);
    plan({ stdout: "ok" });

    await expect(wrangler(["d1", "execute", "APP_DB"], 30_000)).rejects.toThrow(
      "wrangler d1 execute stopped",
    );
    expect(spawned.children).toHaveLength(0);
  });

  test("hands its cleanup no command when none was running", async () => {
    const { stopWrangler } = await freshWrangler();

    expect(await stopWrangler(async (killed) => killed)).toStrictEqual([]);
  });
});
