import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Client } from "@libsql/client";
import { dataDbClient } from "@nonprofits/db/node";
import { type Zippable, zipSync } from "fflate";
import { createDataFile } from "./build.ts";
import { EFILE_FLOORS } from "./efile.ts";
import type { DownloadRetry } from "./load.ts";
import type { SourceConfig } from "./sources.ts";
import { fileTarget, type LoadTarget } from "./target.ts";
import type { TableFloors } from "./verify.ts";

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

/** What a build of the fixtures counts: floors at these clear. */
export const FIXTURE_COUNTS: TableFloors = {
  orgs: 260,
  filings: 10,
  programs: 19,
  in_pub78: 122,
  revocation_date: 26,
  files_990n: 95,
  bmf_run_id: 245,
};

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

/** The data file under `dir` that the load tests apply to. */
const dataFile = (dir: string) => join(dir, "data.db");

/** A client on the data file under `dir`, closed once `use` settles. */
async function withDataFile<T>(
  dir: string,
  use: (data: Client) => Promise<T>,
): Promise<T> {
  const data = dataDbClient(pathToFileURL(dataFile(dir)).href, {});
  try {
    return await use(data);
  } finally {
    data.close();
  }
}

/** The data file under `dir` as the load tests' target. */
export function loadTarget(dir: string): LoadTarget {
  return {
    apply: (file) => withDataFile(dir, (data) => fileTarget(data).apply(file)),
  };
}

/** Builds an empty data file under `dir`, as a build starts one. */
export async function resetDataDb(dir: string): Promise<void> {
  (await createDataFile(dataFile(dir))).close();
}

/** Runs the one statement `sql` against the data file under `dir`; resolves with its rows, as plain objects. */
export function query<T>(dir: string, sql: string): Promise<T[]> {
  return withDataFile(dir, async (data) =>
    (await data.execute(sql)).rows.map((row) => ({ ...row }) as T),
  );
}
