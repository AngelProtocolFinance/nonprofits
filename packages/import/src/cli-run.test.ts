import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DATA_DB_BINDING,
  READ_ACTIVE_SLOT_SQL,
  READ_DATA_META_SQL,
  resetGenerationSql,
} from "@nonprofits/db";
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
import { irsSources, type SourceConfig } from "./sources.ts";
import {
  fixtureServer,
  fixtureSources,
  sqliteWrangler,
} from "./test-support.ts";
import { type D1Ops, localD1, remoteD1, type WranglerRun } from "./wrangler.ts";

let work: string;
let server: Server;
let base: string;
let n = 0;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "cli-run-"));
  ({ server, base } = await fixtureServer());
}, 60_000);

afterAll(async () => {
  server?.close();
  if (work) await rm(work, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The fixture sources, which no real floor in `run` lets a build clear. */
const fixtures = (): SourceConfig => fixtureSources(base, join(work, "efile"));

/** The summary's text, or null when `run` wrote none. */
const summaryText = (file: string) =>
  readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
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
 * commands running when a signal comes, `sources` for the IRS sources (none
 * the tests that stop a run at its first step ever reach). Resolves `exited`
 * with the code a stop ends the process with.
 */
function harness({
  via = (_, next) => next(),
  running = [],
  stop = (then) => then([]),
  sources = () => irsSources({ workDir: join(work, "efile") }),
}: {
  via?: (
    args: readonly string[],
    next: () => Promise<string>,
  ) => Promise<string>;
  running?: string[][];
  stop?: CliDeps["stopWrangler"];
  sources?: CliDeps["sources"];
}) {
  const sqlite = sqliteWrangler();
  const wranglerRun: WranglerRun = (args, timeoutMs) =>
    via(args, () => sqlite(args, timeoutMs));
  let onSignal: ((signal: NodeJS.Signals, code: number) => void) | undefined;
  const exited = deferred<number>();
  const deps: CliDeps = {
    d1: () => remoteD1({ run: wranglerRun }),
    sources,
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
    /** What APP_DB's pointer row holds. */
    pointer: () =>
      app.query<{ active: string; build_id: string; flipped_at: string }>(
        "APP_DB",
        "SELECT active, build_id, flipped_at FROM data_generation WHERE id = 1",
      ),
    /** A data database's generation: slot, build and state. */
    meta: (binding: "DATA_DB_A" | "DATA_DB_B") =>
      app.query<{ slot: string; build_id: string; state: string }>(
        binding,
        READ_DATA_META_SQL,
      ),
    /** Slot b holding a complete build "old", sealed and served before the pointer moved to a: what a rollback serves again. */
    holdPreviousBuild: async () => {
      const file = join(work, `reset-b-${n}.sql`);
      await writeFile(file, resetGenerationSql("b", "old"));
      await app.applyFile(DATA_DB_BINDING.b, file);
      await app.query(
        "DATA_DB_B",
        "UPDATE data_meta SET state = 'complete', built_at = '2000-01-01T00:00:00Z' WHERE id = 1",
      );
      await app.query(
        "APP_DB",
        "UPDATE data_generation SET flipped_at = '2000-01-02T00:00:00Z' WHERE id = 1",
      );
    },
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

    const result = run(
      ["refresh", "--remote", "--summary", h.summary],
      {},
      h.deps,
    );
    await reachedPostRunRead.promise;
    h.signal("SIGINT");

    expect(await h.exited).toBe(130);
    // the run's own failure isn't reported over the stop
    expect(await result).toBe(130);
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

    const result = run(
      ["refresh", "--remote", "--summary", h.summary],
      {},
      h.deps,
    );
    await reachedPostRunRead.promise;
    h.signal("SIGTERM");

    expect(await h.exited).toBe(143);
    expect(await result).toBe(143);
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

/** Silences the run's console, returning what it printed. */
function quiet() {
  return {
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

/** Every line the run printed through `spy`. */
const printed = (spy: ReturnType<typeof quiet>["log"]) =>
  spy.mock.calls.map((args) => args.join(" ")).join("\n");

describe("run --force-verify-failure", { timeout: 60_000 }, () => {
  // `run` verifies against TABLE_FLOORS, which no fixture build clears: both runs
  // below fail verify, and the forced check is the one thing the flag adds
  test("fails the build after the full load, exit 1: the forced check is in the summary, nothing is sealed or served", async () => {
    const h = harness({ sources: fixtures });
    const before = await h.pointer();
    const out = quiet();

    const code = await run(
      ["refresh", "--remote", "--force-verify-failure", "--summary", h.summary],
      {},
      h.deps,
    );

    expect(code).toBe(1);
    const md = await summaryText(h.summary);
    expect(md).toContain("## irs refresh (remote D1): failed\n");
    expect(md).toMatch(
      /^\*\*Failed:\*\* verify failed for build \S+ in DATA_DB_B: .*forced failure/m,
    );
    expect(md).toMatch(
      /^\| forced failure \| FAILED \| --force-verify-failure was given \| \d+\.\d s \|$/m,
    );
    // verified on the full build: the load steps ran before it
    expect(md).toMatch(/^\| loaded efile \| \d+\.\d s \|$/m);
    expect(md).toMatch(/^\| verified \| failed after \d+\.\d s \|$/m);
    expect(printed(out.error)).toContain("forced failure");
    expect(await h.pointer()).toStrictEqual(before);
    expect(await h.meta("DATA_DB_B")).toMatchObject([
      { slot: "b", state: "building" },
    ]);
    expect(await h.claimHolder()).toBeNull();
  });

  test("without the flag the same build fails verify on its floors alone, with no forced check", async () => {
    const h = harness({ sources: fixtures });
    const before = await h.pointer();
    quiet();

    const code = await run(
      ["refresh", "--remote", "--summary", h.summary],
      {},
      h.deps,
    );

    expect(code).toBe(1);
    const md = await summaryText(h.summary);
    expect(md).toMatch(/^\| orgs floor \| FAILED \| orgs: 260, floor \d+/m);
    expect(md).not.toContain("forced failure");
    expect(await h.pointer()).toStrictEqual(before);
  });
});

describe("run's exit codes", { timeout: 60_000 }, () => {
  test.each([
    [
      "a flag the command doesn't take",
      ["refresh", "--build", "x"],
      "refresh takes no --build",
    ],
    [
      "--persist-to with --remote",
      ["rollback", "--remote", "--persist-to", "/x"],
      "--persist-to is for local D1 state only",
    ],
    ["no command", [], ""],
  ])(
    "%s is a usage error: exit 2, the usage on stderr, no summary written",
    async (_, argv, message) => {
      const h = harness({});
      const out = quiet();

      const code = await run([...argv, "--summary", h.summary], {}, h.deps);

      expect(code).toBe(2);
      expect(printed(out.error)).toContain(message);
      expect(printed(out.error)).toContain("usage: node src/cli.ts");
      expect(await summaryText(h.summary)).toBeNull();
    },
  );

  test("a run that failed before touching D1 exits 1 with its summary written", async () => {
    const h = harness({
      via: (args, next) =>
        args.includes("--file")
          ? Promise.reject(new Error('wrangler d1 execute failed: near "x"'))
          : next(),
    });
    quiet();

    const code = await run(
      ["refresh", "--remote", "--summary", h.summary],
      {},
      h.deps,
    );

    expect(code).toBe(1);
    const md = await summaryText(h.summary);
    expect(md).toContain("## irs refresh (remote D1): failed\n");
    expect(md).toContain('**Failed:** wrangler d1 execute failed: near "x"\n');
  });

  test("a rollback that served exits 0, and its summary names the slot it serves", async () => {
    const h = harness({});
    await h.holdPreviousBuild();
    quiet();

    const code = await run(
      ["rollback", "--remote", "--summary", h.summary],
      {},
      h.deps,
    );

    expect(code).toBe(0);
    expect(await summaryText(h.summary)).toContain(
      "## irs rollback (remote D1): serving slot b, build old\n",
    );
  });

  // the workflow's release step takes this exit and wording as "the cut-off stop's own release landed"
  test("release --build for a build holding no claim exits 1 saying so; with no --build and no claim it exits 0", async () => {
    const h = harness({});
    const out = quiet();

    const named = await run(
      ["release", "--remote", "--build", "gone"],
      {},
      h.deps,
    );
    const unnamed = await run(["release", "--remote"], {}, h.deps);

    expect(named).toBe(1);
    expect(unnamed).toBe(0);
    expect(printed(out.log)).toContain(
      "release: build gone holds no claim in remote D1",
    );
  });
});

describe("run with an unwritable --summary", { timeout: 60_000 }, () => {
  const unwritable = () => join(work, "no-such-dir", "summary.md");

  test("is reported on stderr and leaves the run's exit code: 0 for a rollback that served", async () => {
    const h = harness({});
    await h.holdPreviousBuild();
    const out = quiet();

    const code = await run(
      ["rollback", "--remote", "--summary", unwritable()],
      {},
      h.deps,
    );

    expect(code).toBe(0);
    expect(printed(out.error)).toMatch(
      /could not write the summary to .*summary\.md: ENOENT/,
    );
    expect((await h.pointer())[0]?.active).toBe("b");
  });

  test("is reported on stderr beside the failure it would have carried: exit 1", async () => {
    const h = harness({
      via: (args, next) =>
        args.includes("--file")
          ? Promise.reject(new Error("wrangler d1 execute failed: boom"))
          : next(),
    });
    const out = quiet();

    const code = await run(
      ["refresh", "--remote", "--summary", unwritable()],
      {},
      h.deps,
    );

    expect(code).toBe(1);
    expect(printed(out.error)).toContain("wrangler d1 execute failed: boom");
    expect(printed(out.error)).toContain("could not write the summary to");
  });
});
