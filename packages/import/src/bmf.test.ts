import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { importBmf } from "./bmf.ts";
import {
  query as queryD1,
  type Route,
  resetDataDb,
  serve,
} from "./test-support.ts";

const FIXTURES = new URL("../fixtures/bmf/", import.meta.url);
const FIXTURE_FILES = ["eo1.csv", "eo2.csv", "eo3.csv", "eo4.csv"];
const FIXTURE_ROWS = [62, 61, 60, 62];
const FIXTURE_ORGS = 245;
const RELEASED = "Mon, 07 Sep 2026 04:11:46 GMT";
const LATEST_BMF_RUNS =
  "SELECT id FROM import_runs WHERE source = 'bmf' ORDER BY id DESC LIMIT 4";

/** Applies `edit` to the comma-split fields of `ein`'s row; the row must hold no quoted field. */
function editRow(
  csv: string,
  ein: string,
  edit: (fields: string[]) => void,
): string {
  return csv.replace(new RegExp(`^${ein},[^\\r\\n]*`, "m"), (row) => {
    if (row.includes('"')) throw new Error(`row ${ein} has a quoted field`);
    const fields = row.split(",");
    edit(fields);
    return fields.join(",");
  });
}

let server: Server;
let base: string;
let work: string;
let persistTo: string;

function urls(names: readonly string[]): string[] {
  return names.map((name) => `${base}/${name}`);
}

function importFixture(
  names: readonly string[],
  out: string,
  options: { minOrgs?: number; maxStatementBytes?: number } = {},
) {
  return importBmf({
    urls: urls(names),
    minOrgs: options.minOrgs ?? 1,
    out: join(work, out),
    target: { remote: false, persistTo },
    ...(options.maxStatementBytes === undefined
      ? {}
      : { maxStatementBytes: options.maxStatementBytes }),
  });
}

async function counts() {
  return query(
    "SELECT (SELECT count(*) FROM orgs) AS orgs, (SELECT count(*) FROM import_runs) AS runs",
  );
}

function query<T>(sql: string): Promise<T[]> {
  return queryD1<T>(persistTo, sql);
}

beforeAll(async () => {
  const routes = new Map<string, Route>();
  for (const name of FIXTURE_FILES) {
    routes.set(`/${name}`, await readFile(new URL(name, FIXTURES), "utf8"));
  }
  const eo4 = await readFile(new URL("eo4.csv", FIXTURES), "utf8");
  routes.set("/drift/eo4.csv", eo4.replace(",NTEE_CD,", ",NTEE_CODE,"));
  routes.set("/reset/eo4.csv", (res) => {
    res.writeHead(200, {
      "last-modified": RELEASED,
      "content-length": eo4.length,
    });
    res.write(eo4.slice(0, eo4.length / 2), () => res.socket?.destroy());
  });
  let odd = eo4.replace(
    `200443614,INTERNATIONAL FACILITY MANAGEMENT ASSOCIATION INC,% CHAPTER ADMINISTRATOR,"VANCOUVER,BC,V6A 4G2",CANADA,,00000-0000,`,
    "200443614,,% CHAPTER ADMINISTRATOR,,,,,",
  );
  odd = editRow(odd, "200644142", (f) => {
    f[1] = "STRATEGIC SOLUTIONS\0 NETWORK INC";
  });
  odd = editRow(odd, "201096061", (f) => {
    f[11] = "20109";
  });
  routes.set("/odd/eo4.csv", odd);

  ({ server, base } = await serve(routes, RELEASED));
  work = await mkdtemp(join(tmpdir(), "bmf-import-"));
  persistTo = join(work, "d1");
  await resetDataDb(persistTo);
  await importFixture(FIXTURE_FILES, "bmf.load.sql");
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

  test("indexes the loaded names for search", async () => {
    const rows = await query(
      "SELECT rowid FROM orgs_fts WHERE orgs_fts MATCH 'red cross'",
    );
    expect(rows).toStrictEqual([{ rowid: 530196605 }]);
  });

  test("stores IRS placeholder text as null", async () => {
    const rows = await query(
      "SELECT street, city, state, zip FROM orgs WHERE ein = '010384135'",
    );
    expect(rows).toStrictEqual([
      { street: null, city: null, state: "ME", zip: "04062-0000" },
    ]);
  });

  test("keeps an apostrophe in a value", async () => {
    const rows = await query("SELECT city FROM orgs WHERE ein = '311602376'");
    expect(rows).toStrictEqual([{ city: "COTE D'IVOIRE" }]);
  });

  test("records one bmf run per file, released at its Last-Modified, owning its orgs", async () => {
    const rows = await query(
      `SELECT r.source, r.file_url, r.released_at, r.row_count,
        (SELECT count(*) FROM orgs WHERE bmf_run_id = r.id) AS orgs
      FROM import_runs r WHERE r.id IN (${LATEST_BMF_RUNS}) ORDER BY r.id`,
    );
    expect(rows).toStrictEqual(
      FIXTURE_ROWS.map((count, i) => ({
        source: "bmf",
        file_url: urls(FIXTURE_FILES)[i],
        released_at: "2026-09-07T04:11:46.000Z",
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
      importFixture(
        ["eo1.csv", "eo2.csv", "eo3.csv", "drift/eo4.csv"],
        "drift.load.sql",
      ),
    ).rejects.toThrow(
      `BMF layout changed in ${base}/drift/eo4.csv: missing NTEE_CD; unexpected NTEE_CODE`,
    );
    expect(await counts()).toStrictEqual(before);
  });

  test("aborts on a download cut off mid-file, loading nothing and leaving no load file", async () => {
    const before = await counts();
    await expect(
      importFixture(
        ["eo1.csv", "eo2.csv", "eo3.csv", "reset/eo4.csv"],
        "reset.load.sql",
      ),
    ).rejects.toThrow(`BMF download failed: ${base}/reset/eo4.csv: `);
    await expect(access(join(work, "reset.load.sql"))).rejects.toThrow(
      "ENOENT",
    );
    expect(await counts()).toStrictEqual(before);
  });

  test("aborts below the org-count floor, loading nothing", async () => {
    const before = await counts();
    await expect(
      importFixture(FIXTURE_FILES, "short.load.sql", {
        minOrgs: FIXTURE_ORGS + 1,
      }),
    ).rejects.toThrow(
      `BMF import aborted: ${FIXTURE_ORGS} orgs is below the floor of ${FIXTURE_ORGS + 1}`,
    );
    expect(await counts()).toStrictEqual(before);
  });

  test("re-running replaces the orgs in place", async () => {
    await importFixture(FIXTURE_FILES, "rerun.load.sql");
    const rows = await query(
      `SELECT count(*) AS orgs,
        count(*) FILTER (WHERE bmf_run_id IN (${LATEST_BMF_RUNS})) AS from_latest_runs
      FROM orgs`,
    );
    expect(rows).toStrictEqual([
      { orgs: FIXTURE_ORGS, from_latest_runs: FIXTURE_ORGS },
    ]);
  });

  test("splits upserts to fit the statement budget, loading every org", async () => {
    const budget = 4_000;
    await importFixture(FIXTURE_FILES, "batched.load.sql", {
      maxStatementBytes: budget,
    });
    const sql = await readFile(join(work, "batched.load.sql"), "utf8");
    const statements = sql.split(/(?<=;\n)(?=INSERT|UPDATE)/);
    const upserts = statements.filter((s) => s.startsWith("INSERT INTO orgs"));
    expect(upserts.length).toBeGreaterThan(FIXTURE_FILES.length);
    expect(
      statements.filter((s) => Buffer.byteLength(s) > budget),
    ).toStrictEqual([]);
    const rows = await query(
      `SELECT count(*) FILTER (WHERE bmf_run_id IN (${LATEST_BMF_RUNS})) AS from_latest_runs FROM orgs`,
    );
    expect(rows).toStrictEqual([{ from_latest_runs: FIXTURE_ORGS }]);
  });

  test("clears the BMF facts of an org the latest BMF dropped, keeping its name", async () => {
    await importFixture(["eo1.csv", "eo2.csv", "eo3.csv"], "dropped.load.sql");
    const rows = await query(
      "SELECT name, bmf_run_id, subsection, ruling_date FROM orgs WHERE ein IN ('530196605', '200443614') ORDER BY ein",
    );
    await importFixture(FIXTURE_FILES, "restore.load.sql");
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

  describe("over values another source wrote", () => {
    const ORG_WITH_SOURCES = `SELECT o.name, n.source AS name_source, o.street, o.city, o.state, o.zip,
        a.source AS address_source, o.subsection
      FROM orgs o
      JOIN import_runs n ON n.id = o.name_run_id
      JOIN import_runs a ON a.id = o.address_run_id
      WHERE o.ein = ?`;

    beforeAll(async () => {
      await query(`INSERT INTO import_runs (source, file_url, released_at, fetched_at, row_count)
        VALUES ('revocation', 'https://apps.irs.gov/pub/epostcard/data-download-revocation.zip',
          '2026-09-30T00:00:00.000Z', '2026-10-03T00:00:00.000Z', 2);
        UPDATE orgs SET name = 'IFMA VANCOUVER CHAPTER',
          name_run_id = (SELECT max(id) FROM import_runs WHERE source = 'revocation'),
          street = '1 HARBOUR ST', city = 'VANCOUVER', state = 'BC', zip = 'V6A 4G2',
          address_run_id = (SELECT max(id) FROM import_runs WHERE source = 'revocation')
        WHERE ein IN ('200443614', '200443640')`);
      await importFixture(
        ["eo1.csv", "eo2.csv", "eo3.csv", "odd/eo4.csv"],
        "odd.load.sql",
      );
    }, 60_000);

    afterAll(async () => {
      await importFixture(FIXTURE_FILES, "restore.load.sql");
    }, 60_000);

    test("keeps that name and address where the BMF row has none", async () => {
      const rows = await query(ORG_WITH_SOURCES.replace("?", "'200443614'"));
      expect(rows).toStrictEqual([
        {
          name: "IFMA VANCOUVER CHAPTER",
          name_source: "revocation",
          street: "1 HARBOUR ST",
          city: "VANCOUVER",
          state: "BC",
          zip: "V6A 4G2",
          address_source: "revocation",
          subsection: "06",
        },
      ]);
    });

    test("replaces the whole address where the BMF row has any of it", async () => {
      const rows = await query(ORG_WITH_SOURCES.replace("?", "'200443640'"));
      expect(rows).toStrictEqual([
        {
          name: "INTERNATIONAL FACILITY MANAGEMENT ASSOCIATION INC",
          name_source: "bmf",
          street: "REGINA,SK,54P 3B8",
          city: "CANADA",
          state: null,
          zip: "00000-0000",
          address_source: "bmf",
          subsection: "06",
        },
      ]);
    });

    test("strips NUL bytes from text", async () => {
      const rows = await query("SELECT name FROM orgs WHERE ein = '200644142'");
      expect(rows).toStrictEqual([{ name: "STRATEGIC SOLUTIONS NETWORK INC" }]);
    });

    test("stores a ruling that isn't six digits as null", async () => {
      const rows = await query(
        "SELECT ruling_date FROM orgs WHERE ein = '201096061'",
      );
      expect(rows).toStrictEqual([{ ruling_date: null }]);
    });
  });
});
