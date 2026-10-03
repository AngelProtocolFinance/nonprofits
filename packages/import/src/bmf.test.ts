import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { importBmf } from "./bmf.ts";
import { wrangler } from "./wrangler.ts";

const FIXTURES = new URL("../fixtures/bmf/", import.meta.url);
const FIXTURE_FILES = ["eo1.csv", "eo2.csv", "eo3.csv", "eo4.csv"];
const RELEASED = "Mon, 07 Sep 2026 04:11:46 GMT";

/** Serves `files` (path → body) over loopback, each with `RELEASED` as its Last-Modified. */
async function serve(files: Map<string, string>): Promise<Server> {
  const server = createServer((req, res) => {
    const body = files.get(req.url ?? "");
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "last-modified": RELEASED }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

let server: Server;
let base: string;
let work: string;
let persistTo: string;

function urls(names: readonly string[]): string[] {
  return names.map((name) => `${base}/${name}`);
}

async function counts() {
  return query(
    "SELECT (SELECT count(*) FROM orgs) AS orgs, (SELECT count(*) FROM import_runs) AS runs",
  );
}

async function query<T>(sql: string): Promise<T[]> {
  const out = await wrangler([
    "d1",
    "execute",
    "DB",
    "--local",
    "--persist-to",
    persistTo,
    "--json",
    "--command",
    sql,
  ]);
  const [result] = JSON.parse(out) as { results: T[] }[];
  return result?.results ?? [];
}

beforeAll(async () => {
  const files = new Map<string, string>();
  for (const name of FIXTURE_FILES) {
    files.set(`/${name}`, await readFile(new URL(name, FIXTURES), "utf8"));
  }
  const eo4 = files.get("/eo4.csv") ?? "";
  files.set("/drift/eo4.csv", eo4.replace(",NTEE_CD,", ",NTEE_CODE,"));
  server = await serve(files);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  work = await mkdtemp(join(tmpdir(), "bmf-import-"));
  persistTo = join(work, "d1");
  await wrangler([
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--persist-to",
    persistTo,
  ]);
  await importBmf({
    urls: urls(FIXTURE_FILES),
    minOrgs: 1,
    out: join(work, "bmf.load.sql"),
    target: { remote: false, persistTo },
  });
}, 60_000);

afterAll(async () => {
  server?.close();
  if (work) await rm(work, { recursive: true, force: true });
});

describe("importBmf", { timeout: 60_000 }, () => {
  test("loads the Red Cross with its DC address and subsection 03", async () => {
    const rows = await query(
      "SELECT ein, name, street, city, state, zip, subsection, ruling_date FROM orgs WHERE ein = '530196605'",
    );
    expect(rows).toStrictEqual([
      {
        ein: "530196605",
        name: "AMERICAN NATIONAL RED CROSS",
        street: "431 18TH ST NW",
        city: "WASHINGTON",
        state: "DC",
        zip: "20006-5310",
        subsection: "03",
        ruling_date: "1938-12",
      },
    ]);
  });

  test("stores IRS placeholder text as null", async () => {
    const rows = await query(
      "SELECT street, city, state, zip FROM orgs WHERE ein = '010384135'",
    );
    expect(rows).toStrictEqual([
      { street: null, city: null, state: "ME", zip: "04062-0000" },
    ]);
  });

  test("records one bmf run per file, released at its Last-Modified, owning its orgs", async () => {
    const rows = await query(
      `SELECT r.source, r.file_url, r.released_at, r.row_count,
        (SELECT count(*) FROM orgs WHERE bmf_run_id = r.id) AS orgs
      FROM import_runs r WHERE r.id > (SELECT max(id) - 4 FROM import_runs) ORDER BY r.id`,
    );
    const released = "2026-09-07T04:11:46.000Z";
    expect(rows).toStrictEqual(
      [62, 61, 60, 61].map((count, i) => ({
        source: "bmf",
        file_url: urls(FIXTURE_FILES)[i],
        released_at: released,
        row_count: count,
        orgs: count,
      })),
    );
  });

  test("stores an all-zero ruling as null", async () => {
    const rows = await query(
      "SELECT ruling_date FROM orgs WHERE ein = '208713975'",
    );
    expect(rows).toStrictEqual([{ ruling_date: null }]);
  });

  test("aborts on a header that drifted from the BMF layout, loading nothing", async () => {
    const before = await counts();
    await expect(
      importBmf({
        urls: urls(["eo1.csv", "eo2.csv", "eo3.csv", "drift/eo4.csv"]),
        minOrgs: 1,
        out: join(work, "drift.load.sql"),
        target: { remote: false, persistTo },
      }),
    ).rejects.toThrow(
      `BMF layout changed in ${base}/drift/eo4.csv: missing NTEE_CD; unexpected NTEE_CODE`,
    );
    expect(await counts()).toStrictEqual(before);
  });

  test("aborts below the org-count floor, loading nothing", async () => {
    const before = await counts();
    await expect(
      importBmf({
        urls: urls(FIXTURE_FILES),
        minOrgs: 245,
        out: join(work, "short.load.sql"),
        target: { remote: false, persistTo },
      }),
    ).rejects.toThrow("BMF import aborted: 244 orgs is below the floor of 245");
    expect(await counts()).toStrictEqual(before);
  });

  test("re-running replaces the orgs in place", async () => {
    await importBmf({
      urls: urls(FIXTURE_FILES),
      minOrgs: 1,
      out: join(work, "rerun.load.sql"),
      target: { remote: false, persistTo },
    });
    const rows = await query(
      `SELECT count(*) AS orgs,
        count(*) FILTER (WHERE bmf_run_id > (SELECT max(id) - 4 FROM import_runs)) AS from_latest_runs
      FROM orgs`,
    );
    expect(rows).toStrictEqual([{ orgs: 244, from_latest_runs: 244 }]);
  });

  test("clears the BMF facts of an org the latest BMF dropped, keeping its name", async () => {
    const importFiles = (names: readonly string[]) =>
      importBmf({
        urls: urls(names),
        minOrgs: 1,
        out: join(work, "dropped.load.sql"),
        target: { remote: false, persistTo },
      });
    await importFiles(["eo1.csv", "eo2.csv", "eo3.csv"]);
    const rows = await query(
      "SELECT name, bmf_run_id, subsection, ruling_date FROM orgs WHERE ein IN ('530196605', '200443614') ORDER BY ein",
    );
    await importFiles(FIXTURE_FILES);
    expect(rows).toStrictEqual([
      {
        name: "INTERNATIONAL FACILITY MANAGEMENT ASSOCIATION INC",
        bmf_run_id: null,
        subsection: null,
        ruling_date: null,
      },
      {
        name: "AMERICAN NATIONAL RED CROSS",
        bmf_run_id: expect.any(Number),
        subsection: "03",
        ruling_date: "1938-12",
      },
    ]);
  });
});
