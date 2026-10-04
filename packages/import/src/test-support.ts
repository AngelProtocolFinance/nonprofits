import { readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { DATA_DB_BINDING, resetGenerationSql } from "@nonprofits/db";
import { type Zippable, zipSync } from "fflate";
import { EFILE_FLOORS } from "./efile.ts";
import type { DownloadRetry } from "./load.ts";
import type { SourceConfig } from "./sources.ts";
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

const FIXTURES = new URL("../fixtures/", import.meta.url);
const BMF_FILES = ["eo1.csv", "eo2.csv", "eo3.csv", "eo4.csv"];
const FIXTURE_LISTS = ["pub78", "revocation", "epostcard"] as const;
export type FixtureList = (typeof FIXTURE_LISTS)[number];
/** The lines each list's cut route keeps: its two blank lines and the rows after them, Pub 78's leaving out the Red Cross. */
const CUT_LINES: Record<FixtureList, number> = {
  pub78: 62,
  revocation: 14,
  epostcard: 52,
};
const RELEASED = "Wed, 16 Sep 2026 13:02:21 GMT";
/** The fixture returns each batch zip holds, as `efile.test.ts` serves them. */
const ZIPS: Record<string, string[]> = {
  "2026_TEOS_XML_01A": [
    "202630139349301998",
    "202620149349301082",
    "202630139349200908",
    "202630139349100013",
  ],
  "2026_TEOS_XML_02A": [
    "202620389349300312",
    "202640389349300504",
    "202620339349301487",
  ],
  "2026_TEOS_XML_03A": ["202640829349300109", "202630729349100528"],
  "2026_TEOS_XML_05A": ["202620339349301487"],
  "2026_TEOS_XML_05B": ["202631339349308133"],
  "2026_TEOS_XML_06A": ["202601499349300130"],
  "2024_TEOS_XML_05A": ["202431369349308428"],
};

/** Serves every IRS source's fixtures over loopback (BMF, the three lists and a cut route of each, the e-file indexes and batch zips), as `fixtureSources` points at them. */
export async function fixtureServer(): Promise<{
  server: Server;
  base: string;
}> {
  const routes = new Map<string, Route>();
  for (const name of BMF_FILES) {
    routes.set(
      `/${name}`,
      await readFile(new URL(`bmf/${name}`, FIXTURES), "utf8"),
    );
  }
  for (const list of FIXTURE_LISTS) {
    const name = `data-download-${list}.txt`;
    const text = await readFile(new URL(`lists/${name}`, FIXTURES));
    routes.set(`/${list}.zip`, zipSync({ [name]: [text, { level: 6 }] }));
    const lines = text.toString("utf8").split("\n");
    const cut = `${lines.slice(0, CUT_LINES[list]).join("\n")}\n`;
    routes.set(
      `/${list}-cut.zip`,
      zipSync({ [name]: [Buffer.from(cut), { level: 6 }] }),
    );
  }
  for (const year of [2024, 2025, 2026]) {
    routes.set(
      `/xml/${year}/index_${year}.csv`,
      await readFile(new URL(`efile/index_${year}.csv`, FIXTURES)),
    );
  }
  for (const [batch, objectIds] of Object.entries(ZIPS)) {
    const files: Zippable = {};
    for (const id of objectIds) {
      files[`${id}_public.xml`] = [
        await readFile(new URL(`efile/xml/${id}_public.xml`, FIXTURES)),
        { level: 6 },
      ];
    }
    routes.set(`/xml/${batch.slice(0, 4)}/${batch}.zip`, zipSync(files));
  }
  return serve(routes, RELEASED);
}

/** The sources `fixtureServer` serves at `base`: `bmf` region files only, and the cut route of each list in `cut`; floors the fixtures clear. */
export function fixtureSources(
  base: string,
  workDir: string,
  bmf: readonly string[] = BMF_FILES,
  cut: readonly FixtureList[] = [],
): SourceConfig {
  const list = (name: FixtureList) => ({
    url: `${base}/${name}${cut.includes(name) ? "-cut" : ""}.zip`,
    minRows: 1,
  });
  return {
    bmf: { urls: bmf.map((name) => `${base}/${name}`), minOrgs: 1 },
    lists: {
      pub78: list("pub78"),
      revocation: list("revocation"),
      epostcard: list("epostcard"),
    },
    efile: {
      baseUrl: `${base}/xml/`,
      latestYear: 2026,
      floors: EFILE_FLOORS,
      workDir,
    },
  };
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
