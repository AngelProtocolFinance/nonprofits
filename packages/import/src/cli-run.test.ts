import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READ_ACTIVE_SLOT_SQL } from "@nonprofits/db";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { type CliDeps, run } from "./cli.ts";
import { KEEPS_CLAIM_GREP, RELEASE_LINE_SED } from "./generation.ts";
import { irsSources } from "./sources.ts";
import { sqliteWrangler } from "./test-support.ts";
import { type D1Ops, localD1, remoteD1, type WranglerRun } from "./wrangler.ts";

let work: string;
let n = 0;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "cli-run-"));
});

afterAll(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

/** The build ids the monthly workflow's release step would release from `summary`: none once it finds a kept claim, else those its sed prints. */
async function releaseStepBuilds(summary: string): Promise<string[]> {
  if ((await readFile(summary, "utf8")).includes(KEEPS_CLAIM_GREP)) return [];
  return new Promise((resolve, reject) => {
    execFile("sed", ["-n", RELEASE_LINE_SED, summary], (error, stdout) =>
      error === null
        ? resolve(stdout.split("\n").filter(Boolean))
        : reject(error),
    );
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The wrangler args a remote `--command` runs `sql` with. */
const remoteCommand = (binding: string, sql: string) => [
  "d1",
  "execute",
  binding,
  "--remote",
  "--yes",
  "--json",
  "--command",
  sql,
];

/**
 * `run` against in-memory D1 through `remoteD1`, `via` seeing each wrangler
 * command first; `stop` stands in for `stopWrangler` and `running` for the
 * commands running when a signal comes. Resolves `exited` with the code a
 * stop ends the process with.
 */
function harness({
  via,
  running = [],
  stop,
}: {
  via: (
    args: readonly string[],
    next: () => Promise<string>,
  ) => Promise<string>;
  running?: string[][];
  stop: CliDeps["stopWrangler"];
}) {
  const sqlite = sqliteWrangler();
  const wranglerRun: WranglerRun = (args, timeoutMs) =>
    via(args, () => sqlite(args, timeoutMs));
  let onSignal: ((signal: NodeJS.Signals, code: number) => void) | undefined;
  const exited = deferred<number>();
  const deps: CliDeps = {
    d1: () => remoteD1({ run: wranglerRun }),
    sources: () => irsSources({ workDir: join(work, "efile") }),
    loadDir: join(work, "load"),
    onSignal: (stop) => {
      onSignal = stop;
    },
    stopWrangler: stop,
    runningWrangler: () => running,
    exit: (code) => exited.resolve(code),
  };
  const app: D1Ops = localD1(undefined, { run: sqlite });
  const summary = join(work, `summary-${++n}.md`);
  return {
    deps,
    summary,
    signal: (signal: NodeJS.Signals) =>
      onSignal?.(signal, signal === "SIGINT" ? 130 : 143),
    exited: exited.promise,
    claimHolder: async () =>
      (
        await app.query<{ claim_build_id: string | null }>(
          "APP_DB",
          "SELECT claim_build_id FROM data_generation WHERE id = 1",
        )
      )[0]?.claim_build_id,
  };
}

describe("run", () => {
  test("a signal during the pointer read after a refresh that kept its claim leaves that claim held, saying so", async () => {
    const postRunRead = deferred<string>();
    const reachedPostRunRead = deferred<void>();
    let pointerReads = 0;
    const killedRead = remoteCommand("APP_DB", READ_ACTIVE_SLOT_SQL);
    const h = harness({
      via: (args, next) => {
        if (args.includes("--file")) {
          return Promise.reject(
            new Error("wrangler d1 execute timed out after 7200000 ms"),
          );
        }
        if (args.includes(READ_ACTIVE_SLOT_SQL) && ++pointerReads === 2) {
          reachedPostRunRead.resolve();
          return postRunRead.promise;
        }
        return next();
      },
      running: [killedRead],
      stop: async (then) => {
        postRunRead.reject(new Error("wrangler d1 execute stopped"));
        return then([killedRead]);
      },
    });

    void run(["refresh", "--remote", "--summary", h.summary], {}, h.deps);
    await reachedPostRunRead.promise;
    h.signal("SIGINT");

    expect(await h.exited).toBe(130);
    const held = await h.claimHolder();
    expect(held).toMatch(/^\d{4}-\d\d-\d\dT/);
    const md = await readFile(h.summary, "utf8");
    expect(md).toContain(
      `**Claim kept:** build ${held} keeps its claim: DATA_DB_B's import may still be running in D1`,
    );
    expect(md).not.toContain("released build");
  });

  test("a signal during the pointer read after a failed refresh leaves the summary to the stop, which says what its cleanup did", async () => {
    const postRunRead = deferred<string>();
    const reachedPostRunRead = deferred<void>();
    let pointerReads = 0;
    const killedRead = remoteCommand("APP_DB", READ_ACTIVE_SLOT_SQL);
    const h = harness({
      via: (args, next) => {
        if (args.includes("--file")) {
          return Promise.reject(
            new Error('wrangler d1 execute failed: near "x": syntax error'),
          );
        }
        if (args.includes(READ_ACTIVE_SLOT_SQL) && ++pointerReads === 2) {
          reachedPostRunRead.resolve();
          return postRunRead.promise;
        }
        return next();
      },
      running: [killedRead],
      stop: async (then) => {
        postRunRead.reject(new Error("wrangler d1 execute stopped"));
        // the killed command's rejection settles before the cleanup starts
        await new Promise((resolve) => setImmediate(resolve));
        return then([killedRead]);
      },
    });

    void run(["refresh", "--remote", "--summary", h.summary], {}, h.deps);
    await reachedPostRunRead.promise;
    h.signal("SIGTERM");

    expect(await h.exited).toBe(143);
    const md = await readFile(h.summary, "utf8");
    expect(md.match(/^## /gm)).toHaveLength(1);
    expect(md).toContain("## irs refresh (remote D1): stopped by SIGTERM\n");
    expect(md).toMatch(/^- build \S+ holds no claim$/m);
    expect(md).toContain("- serving slot a (build empty)\n");
    expect(md).not.toContain("served after");
  });

  test.each([
    [
      "a remote load file was running: the claim is kept, and the workflow's release step finds nothing to release",
      [
        "d1",
        "execute",
        "DATA_DB_B",
        "--remote",
        "--yes",
        "--file",
        "reset-b.sql",
      ],
      true,
    ],
    [
      "only a query was running: it names the release, which the workflow's release step finds",
      remoteCommand("APP_DB", "SELECT 1"),
      false,
    ],
  ])("a stop cut off at 7 s when %s", async (_, running, kept) => {
    const reachedApply = deferred<void>();
    const h = harness({
      via: (args, next) => {
        if (args.includes("--file")) {
          reachedApply.resolve();
          return new Promise(() => {});
        }
        return next();
      },
      running: [running],
      // the killed command never exits
      stop: () => new Promise(() => {}),
    });

    void run(["refresh", "--remote", "--summary", h.summary], {}, h.deps);
    await reachedApply.promise;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    h.signal("SIGINT");
    await vi.advanceTimersByTimeAsync(7_000);

    expect(await h.exited).toBe(130);
    const held = await h.claimHolder();
    expect(held).toMatch(/^\d{4}-\d\d-\d\dT/);
    const md = await readFile(h.summary, "utf8");
    expect(md).toContain("- stop cut off after 7 s\n");
    if (kept) {
      expect(md).toContain(
        `**Claim kept:** build ${held} keeps its claim: DATA_DB_B's import may still be running in D1`,
      );
      expect(await releaseStepBuilds(h.summary)).toStrictEqual([]);
    } else {
      expect(md).not.toContain("**Claim kept:**");
      expect(await releaseStepBuilds(h.summary)).toStrictEqual([held]);
    }
  });

  test("a stop whose release failed with 16 MiB of wrangler output still names the release the workflow's release step finds", async () => {
    const reachedApply = deferred<void>();
    const huge = Array.from({ length: 16 }, () => "x".repeat(1024 * 1024)).join(
      "\n",
    );
    const h = harness({
      via: (args, next) => {
        if (args.includes("--file")) {
          reachedApply.resolve();
          return new Promise(() => {});
        }
        if (args.some((arg) => arg.includes("SET claim_slot = NULL"))) {
          return Promise.reject(
            new Error(`wrangler d1 execute failed: ${huge}`),
          );
        }
        return next();
      },
      stop: (then) => then([]),
    });

    void run(["refresh", "--remote", "--summary", h.summary], {}, h.deps);
    await reachedApply.promise;
    h.signal("SIGINT");

    expect(await h.exited).toBe(130);
    const held = await h.claimHolder();
    expect(held).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(await releaseStepBuilds(h.summary)).toStrictEqual([held]);
  });
});
