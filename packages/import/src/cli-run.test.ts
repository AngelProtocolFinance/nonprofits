import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@libsql/client";
import { readServedDatabase } from "@nonprofits/db";
import { appDbFixture, type LocalDb } from "@nonprofits/db/fixture";
import { dataDbClient } from "@nonprofits/db/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { type BuildReport, buildDataFile } from "./build.ts";
import { type CliDeps, openDatabases, run } from "./cli.ts";
import { localDatabases } from "./database-host.ts";
import { type DatabaseHost, publishDataFile } from "./publish.ts";
import {
  FIXTURE_COUNTS,
  fixtureServer,
  fixtureSources,
} from "./test-support.ts";

let work: string;
let server: Server;
let base: string;
/** A fixture build from an earlier month: what each test serves before its own run. */
let earlier: BuildReport;
let n = 0;
const apps: LocalDb[] = [];

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "cli-run-"));
  ({ server, base } = await fixtureServer());
  // a build id of its own, a month before any run's
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-03T06:17:00Z") });
  try {
    earlier = await buildDataFile({
      sources: fixtureSources(base, join(work, "earlier", "efile")),
      floors: FIXTURE_COUNTS,
      out: join(work, "earlier", "data.db"),
      loadDir: join(work, "earlier", "load"),
    });
  } finally {
    vi.useRealTimers();
  }
}, 60_000);

afterAll(async () => {
  server?.close();
  await Promise.all(apps.map((app) => app.dispose()));
  if (work) await rm(work, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * `run`'s deps on a local app database serving `earlier`, the default where
 * `TURSO_APP_DB_URL` is unset, publishing to local files under the test's own
 * directory through `wrap(host)`, its app client through `wrapApp`; the fixture sources, from `batches` alone
 * when given, the floors they clear, and a grace period that takes no time.
 */
async function harness({
  wrap = (host) => host,
  wrapApp = (app) => app,
}: {
  wrap?: (host: DatabaseHost) => DatabaseHost;
  wrapApp?: (app: Client) => Client;
} = {}) {
  const dir = join(work, `run-${++n}`);
  const app = await appDbFixture();
  apps.push(app);
  const databases = join(dir, "databases");
  let onSignal: ((signal: NodeJS.Signals, code: number) => void) | undefined;
  const exited = deferred<number>();
  await publishDataFile({
    app: app.client,
    host: localDatabases(databases),
    file: earlier.out,
    buildId: earlier.buildId,
    counts: earlier.counts,
    sleep: async () => {},
  });
  const deps: CliDeps = {
    databases: (env) => {
      const opened = openDatabases(env, { appDb: app.url, dataDir: databases });
      return { app: wrapApp(opened.app), host: wrap(opened.host) };
    },
    sources: (batches) => {
      const sources = fixtureSources(base, join(dir, "efile"));
      return batches === undefined
        ? sources
        : { ...sources, efile: { ...sources.efile, batches } };
    },
    floors: FIXTURE_COUNTS,
    loadDir: join(dir, "load"),
    dataFile: join(dir, "data", "nonprofits.db"),
    sleep: async () => {},
    onSignal: (stop) => {
      onSignal = stop;
    },
    exit: (code) => exited.resolve(code),
  };
  return {
    deps,
    signal: (signal: NodeJS.Signals) =>
      onSignal?.(signal, signal === "SIGINT" ? 130 : 143),
    /** The code a stop exits with. */
    exited: exited.promise,
    summary: join(dir, "summary.md"),
    /** What the pointer serves now. */
    served: () => readServedDatabase(app.client),
    /** The pointer's row and the bytes of the database it serves. */
    snapshot: async () => {
      const pointer = await readServedDatabase(app.client);
      const url = pointer.database?.url;
      return {
        pointer,
        bytes: url === undefined ? null : await readFile(fileURLToPath(url)),
      };
    },
    /** Runs `sql` on the database served now. */
    onServed: async (sql: string) => {
      const { database } = await readServedDatabase(app.client);
      const data = dataDbClient(database?.url ?? "", {});
      try {
        await data.execute(sql);
      } finally {
        data.close();
      }
    },
    /** The data databases on the host, by file name. */
    databaseFiles: async () =>
      (await readdir(databases)).filter((f) => f.endsWith(".db")).sort(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Resolves once `point` does; fails at once if the run `result` ends first. */
function reached(point: Promise<void>, result: Promise<number>) {
  return Promise.race([
    point,
    result.then((code) => {
      throw new Error(`the run ended first, exit ${code}`);
    }),
  ]);
}

/**
 * `host`, its upload copying the file and then holding until the publish's
 * signal aborts it, as a long upload does; `uploading` resolves once it holds.
 */
function holdingUpload(uploading: { resolve: () => void }) {
  return (host: DatabaseHost): DatabaseHost => ({
    ...host,
    async upload(database, file, signal) {
      await host.upload(database, file, signal);
      uploading.resolve();
      await new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    },
  });
}

/** Every line the run printed through `spy`. */
const printed = (spy: ReturnType<typeof quiet>["log"]) =>
  spy.mock.calls.map((args) => args.join(" ")).join("\n");

/** Silences the run's console, returning the spies that record what it printed. */
function quiet() {
  return {
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

describe("run refresh", { timeout: 60_000 }, () => {
  test("builds, verifies and publishes a new database: the pointer names it, and the one served before is gone", async () => {
    const h = await harness();
    const before = await h.served();
    quiet();

    const code = await run(["refresh"], {}, h.deps);

    expect(code).toBe(0);
    const after = await h.served();
    expect(after.database?.name).toMatch(/^nonprofits-data-\d{8}t\d{6}z$/);
    expect(after.database?.name).not.toBe(before.database?.name);
    expect(after.build_id).not.toBe(earlier.buildId);
    expect(await h.databaseFiles()).toStrictEqual([
      `${after.database?.name}.db`,
    ]);
    expect(existsSync(h.deps.dataFile)).toBe(true);
  });
});

describe("run refresh --force-verify-failure", { timeout: 60_000 }, () => {
  test("fails after the full build, exit 1: the summary says nothing was switched, and the pointer and the served database are byte for byte as they were", async () => {
    const h = await harness();
    const before = await h.snapshot();
    quiet();

    const code = await run(
      ["refresh", "--force-verify-failure", "--summary", h.summary],
      {},
      h.deps,
    );

    expect(code).toBe(1);
    const md = await readFile(h.summary, "utf8");
    expect(md).toContain("## irs refresh: failed\n");
    expect(md).toMatch(
      /^\*\*Failed:\*\* verify failed for build \S+: .*forced failure/m,
    );
    expect(md).toContain(
      `**Nothing switched:** still serving ${before.pointer.database?.name}, build ${earlier.buildId}\n`,
    );
    // verified on the full build, against the served counts
    expect(md).toMatch(/^\| loaded efile \| \d+\.\d s \|$/m);
    expect(md).toMatch(/^\| orgs vs served \| ok \| orgs: 260, served 260 \|/m);
    expect(await h.snapshot()).toStrictEqual(before);
    expect(await h.databaseFiles()).toStrictEqual([
      `${before.pointer.database?.name}.db`,
    ]);
  });
});

describe("a stop during refresh", { timeout: 60_000 }, () => {
  test("SIGINT during the upload removes the database being made, leaves the one served before serving, and exits 130 with the summary saying so", async () => {
    const uploading = deferred<void>();
    const h = await harness({ wrap: holdingUpload(uploading) });
    const before = await h.snapshot();
    const out = quiet();

    const result = run(["refresh", "--summary", h.summary], {}, h.deps);
    await reached(uploading.promise, result);
    h.signal("SIGINT");

    expect(await h.exited).toBe(130);
    expect(await result).toBe(130);
    expect(await h.snapshot()).toStrictEqual(before);
    expect(await h.databaseFiles()).toStrictEqual([
      `${before.pointer.database?.name}.db`,
    ]);
    const md = await readFile(h.summary, "utf8");
    expect(md.match(/^## /gm)).toHaveLength(1);
    expect(md).toContain("## irs refresh: stopped by SIGINT\n");
    expect(md).toContain(
      `**Nothing switched:** still serving ${before.pointer.database?.name}, build ${earlier.buildId}\n`,
    );
    expect(md).toMatch(/^\| published \| failed after \d+\.\d s \|$/m);
    expect(printed(out.error)).toContain(
      `stopped: serving ${before.pointer.database?.name}, build ${earlier.buildId}`,
    );
  });

  test("a stop cut off at 7 s while the database being made is still being removed names it only beside what to check first, never as cleanup", async () => {
    const uploading = deferred<void>();
    const removing = deferred<void>();
    const h = await harness({
      wrap: (host) => ({
        ...holdingUpload(uploading)(host),
        // Turso's delete, answering only once the test lets it
        remove: async (name) => {
          await removing.promise;
          await host.remove(name);
        },
      }),
    });
    const out = quiet();

    const result = run(["refresh", "--summary", h.summary], {}, h.deps);
    await reached(uploading.promise, result);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    h.signal("SIGTERM");
    await vi.advanceTimersByTimeAsync(7_000);

    expect(await h.exited).toBe(143);
    const served = `${(await h.served()).database?.name}.db`;
    const [made] = (await h.databaseFiles()).filter((f) => f !== served);
    const name = made?.replace(/\.db$/, "") ?? "";
    expect(name).toMatch(/^nonprofits-data-/);
    const md = await readFile(h.summary, "utf8");
    expect(md).toMatch(
      new RegExp(
        `^- stop cut off after 7 s publishing ${name}: read what the pointer names first; unless it is ${name}, \`rm -f '[^']*/${name}\\.db' .*\` removes it$`,
        "m",
      ),
    );
    expect(md).not.toContain("**Cleanup:**");
    expect(printed(out.error)).toContain("stop cut off after 7 s");
    removing.resolve();
    expect(await result).toBe(143);
  });

  test("a stop cut off at 7 s after the publish settled keeps the publish's cleanup, the database served before, and names the served one nowhere", async () => {
    const sleeping = deferred<void>();
    let hang = false;
    const h = await harness({
      // the pointer read after the publish never answers
      wrapApp: (app) =>
        new Proxy(app, {
          get(target, key) {
            if (key === "execute" && hang) return () => new Promise(() => {});
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    const before = await h.served();
    h.deps.sleep = (_, signal) => {
      sleeping.resolve();
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => {
          hang = true;
          reject(signal.reason);
        });
      });
    };
    quiet();

    const result = run(["refresh", "--summary", h.summary], {}, h.deps);
    await reached(sleeping.promise, result);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    h.signal("SIGINT");
    await vi.advanceTimersByTimeAsync(7_000);

    expect(await h.exited).toBe(130);
    const after = await h.served();
    expect(after.database?.name).not.toBe(before.database?.name);
    const md = await readFile(h.summary, "utf8");
    expect(md).toContain("- stop cut off after 7 s\n");
    expect(md).toMatch(
      new RegExp(
        `^\\*\\*Cleanup:\\*\\* \`rm -f '[^']*/${before.database?.name}\\.db' `,
        "m",
      ),
    );
    expect(md).not.toContain(`${after.database?.name}.db`);
    expect(await h.databaseFiles()).toStrictEqual(
      [`${before.database?.name}.db`, `${after.database?.name}.db`].sort(),
    );
    expect(await result).toBe(130);
  });
});

describe("run on a Turso Cloud app database", { timeout: 60_000 }, () => {
  test("missing a Platform setting fails before anything is downloaded or built, exit 1, naming each one missing", async () => {
    const h = await harness();
    const out = quiet();

    const code = await run(
      ["refresh", "--summary", h.summary],
      {
        TURSO_APP_DB_URL: "libsql://nonprofits-app-acme.aws-us-east-1.turso.io",
        TURSO_ORG: "acme",
      },
      h.deps,
    );

    expect(code).toBe(1);
    expect(printed(out.error)).toContain(
      "TURSO_PLATFORM_TOKEN, TURSO_GROUP not set",
    );
    expect(await readFile(h.summary, "utf8")).toMatch(
      /^\*\*Failed:\*\* TURSO_PLATFORM_TOKEN, TURSO_GROUP not set/m,
    );
    expect(existsSync(join(h.deps.loadDir, "bmf.load.sql"))).toBe(false);
  });
});

describe("run's usage errors", () => {
  test.each([
    [
      "refresh --efile-batch, which would publish a partial build",
      ["refresh", "--efile-batch", "2026_TEOS_XML_01A"],
      "refresh publishes only a full build: irs build --efile-batch builds a partial file without publishing it",
    ],
    [
      "a flag the command doesn't take",
      ["build", "--summary", "x"],
      "build takes no --summary",
    ],
    [
      "a flag no command takes",
      ["refresh", "--remote"],
      "Unknown option '--remote'",
    ],
    ["a command there is no more", ["rollback"], ""],
  ])(
    "%s: exit 2, the usage on stderr, nothing built",
    async (_, argv, message) => {
      const h = await harness();
      const out = quiet();

      const code = await run(argv, {}, h.deps);

      expect(code).toBe(2);
      expect(printed(out.error)).toContain(message);
      expect(printed(out.error)).toContain("usage: node src/cli.ts");
      expect(existsSync(join(h.deps.loadDir, "bmf.load.sql"))).toBe(false);
    },
  );
});

describe("run build", { timeout: 60_000 }, () => {
  test("holds the file to the served database's counts: one more than 10% off fails it, exit 1, leaving no file", async () => {
    const h = await harness();
    await h.onServed("UPDATE orgs SET in_pub78 = 0");
    const out = quiet();

    const code = await run(["build"], {}, h.deps);

    expect(code).toBe(1);
    expect(printed(out.error)).toContain(
      "in_pub78 vs served (in_pub78: 122, served 0)",
    );
    expect(existsSync(h.deps.dataFile)).toBe(false);
  });

  test("--efile-batch builds a partial file, held to no served counts", async () => {
    const h = await harness();
    await h.onServed("UPDATE orgs SET in_pub78 = 0");
    const out = quiet();

    const code = await run(
      ["build", "--efile-batch", "2026_TEOS_XML_03A"],
      {},
      // the orgs only other batches' filings bring are missing too
      { ...h.deps, floors: { ...FIXTURE_COUNTS, orgs: 250 } },
    );

    expect(printed(out.error)).toBe("");
    expect(code).toBe(0);
    expect(printed(out.log)).toContain(
      "a partial build: its counts are compared with no served build's",
    );
    expect(printed(out.log)).not.toContain("no served build to compare");
    expect(existsSync(h.deps.dataFile)).toBe(true);
  });
});
