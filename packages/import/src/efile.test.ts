import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { importBmf } from "./bmf.ts";
import { type EfileImportOptions, importEfile, releaseYears } from "./efile.ts";
import { migrate, query, type Route, serve } from "./test-support.ts";

const BMF_FIXTURES = new URL("../fixtures/bmf/", import.meta.url);
const BMF_FILES = ["eo1.csv", "eo2.csv", "eo3.csv", "eo4.csv"];
const EFILE_FIXTURES = new URL("../fixtures/efile/", import.meta.url);
const YEARS = [2026, 2025, 2024];
const RELEASED = "Wed, 16 Sep 2026 13:02:21 GMT";

/** Real returns in `fixtures/efile/xml/`, by what each stands for here. */
const RED_CROSS_990 = "202640829349300109";
/** A 990-PF; its EIN is in no other fixture. */
const PF = "202630729349100528";
/** Delta Triton's 990 for 2024-06 and the later one for 2025-06, which only the current index lists. */
const DELTA_TRITON_OLD = "202620389349300312";
const DELTA_TRITON_NEW = "202640389349300504";
/** Listed in index batch 05A, held in the IRS's second zip for it, 05B. */
const IN_SECOND_ZIP = "202631339349308133";
/** Only the older index lists this one. */
const DROPPED = "202620339349301487";
/** Written with every element prefixed `irs:`. */
const PREFIXED = "202601499349300130";
/** Listed in index batch `2024_TEOS_XML_05a`; the IRS serves it as `…05A.zip`. */
const LOWERCASE_BATCH = "202431369349308428";

/** Which fixture returns each batch zip holds, as served for both index variants. */
const ZIPS: Record<string, string[]> = {
  "2026_TEOS_XML_01A": ["202630139349301998", "202620149349301082"],
  "2026_TEOS_XML_02A": [DELTA_TRITON_OLD, DELTA_TRITON_NEW, DROPPED],
  "2026_TEOS_XML_03A": [RED_CROSS_990, PF],
  // the IRS's 05A zip holds none of the fixture filings its index rows name
  "2026_TEOS_XML_05A": [DROPPED],
  "2026_TEOS_XML_05B": [IN_SECOND_ZIP],
  "2026_TEOS_XML_06A": [PREFIXED],
  "2024_TEOS_XML_05A": [LOWERCASE_BATCH],
};

function fixture(path: string): Promise<Buffer> {
  return readFile(new URL(path, EFILE_FIXTURES));
}

/** A zip of `files`, deflated like the IRS's. */
function zip(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, data]) => [name, [data, { level: 6 }]]),
    ),
  );
}

/** A batch zip holding the fixture returns `objectIds`, named as the IRS names them. */
async function batchZip(objectIds: readonly string[]): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const id of objectIds) {
    files[`${id}_public.xml`] = await fixture(`xml/${id}_public.xml`);
  }
  return zip(files);
}

let server: Server;
let base: string;
let work: string;

beforeAll(async () => {
  const routes = new Map<string, Route>();
  for (const name of BMF_FILES) {
    routes.set(`/${name}`, await readFile(new URL(name, BMF_FIXTURES), "utf8"));
  }
  for (const year of YEARS) {
    const index = (await fixture(`index_${year}.csv`)).toString("utf8");
    routes.set(`/xml/${year}/index_${year}.csv`, index);
    routes.set(
      `/older/${year}/index_${year}.csv`,
      await fixture(`older/index_${year}.csv`),
    );
    routes.set(`/missing/${year}/index_${year}.csv`, index);
    routes.set(
      `/drifted/${year}/index_${year}.csv`,
      index
        .split("\r\n")
        .filter((line, n) => n === 0 || line.includes(",530196605,"))
        .join("\r\n"),
    );
  }
  for (const [batch, objectIds] of Object.entries(ZIPS)) {
    const zipped = await batchZip(objectIds);
    const path = `${batch.slice(0, 4)}/${batch}.zip`;
    routes.set(`/xml/${path}`, zipped);
    routes.set(`/older/${path}`, zipped);
    if (batch !== "2026_TEOS_XML_06A") routes.set(`/missing/${path}`, zipped);
  }
  routes.set("/missing/2026/2026_TEOS_XML_06A.zip", await batchZip([PF]));
  // the 990 as it would read had the IRS renamed both elements the floor watches
  const drifted = (await fixture(`xml/${RED_CROSS_990}_public.xml`))
    .toString("utf8")
    .replaceAll("MissionDesc>", "MissionStatementTxt>")
    .replaceAll("CYTotalRevenueAmt>", "CurrentYearTotalRevenueAmt>");
  routes.set(
    "/drifted/2026/2026_TEOS_XML_03A.zip",
    zip({ [`${RED_CROSS_990}_public.xml`]: Buffer.from(drifted) }),
  );
  ({ server, base } = await serve(routes, RELEASED));
  work = await mkdtemp(join(tmpdir(), "efile-import-"));
}, 60_000);

afterAll(async () => {
  server?.close();
  if (work) await rm(work, { recursive: true, force: true });
});

/** A fresh local D1 under `work`, migrated and loaded with the BMF fixture. */
async function d1WithBmf(name: string): Promise<string> {
  const persistTo = join(work, name);
  await migrate(persistTo);
  await importBmf({
    urls: BMF_FILES.map((file) => `${base}/${file}`),
    minOrgs: 1,
    out: join(work, `${name}-bmf.load.sql`),
    target: { remote: false, persistTo },
  });
  return persistTo;
}

function loadEfile(
  persistTo: string,
  options: Partial<EfileImportOptions> = {},
) {
  return importEfile({
    baseUrl: `${base}/xml/`,
    years: YEARS,
    minYield: { mission: 0.9, revenue: 0.9 },
    workDir: join(work, "batches"),
    out: join(work, "efile.load.sql"),
    target: { remote: false, persistTo },
    ...options,
  });
}

/** Each stored filing's object id and the zip its run cites, by EIN. */
async function storedFilings(
  d1: string,
): Promise<Record<string, [string, string]>> {
  const rows = await query<{
    ein: string;
    object_id: string;
    file_url: string;
  }>(
    d1,
    "SELECT f.ein, f.object_id, r.file_url FROM filings f JOIN import_runs r ON r.id = f.run_id ORDER BY f.ein",
  );
  return Object.fromEntries(
    rows.map((r) => [
      r.ein,
      [r.object_id, r.file_url.slice(r.file_url.lastIndexOf("/") + 1)],
    ]),
  );
}

describe("importing the batch that holds the Red Cross's latest 990", {
  timeout: 60_000,
}, () => {
  let d1: string;

  beforeAll(async () => {
    d1 = await d1WithBmf("red-cross");
    await loadEfile(d1, { batches: ["2026_TEOS_XML_03A"] });
  }, 120_000);

  test("stores its filing facts, citing the batch zip it came from", async () => {
    const rows = await query(
      d1,
      `SELECT f.object_id, f.return_id, f.form_type, f.tax_period, f.tax_year,
        f.mission, f.website, f.total_revenue, f.total_expenses, f.total_assets_eoy,
        r.source, r.file_url, r.released_at, r.row_count
      FROM filings f JOIN import_runs r ON r.id = f.run_id
      WHERE f.ein = '530196605'`,
    );
    expect(rows).toStrictEqual([
      {
        object_id: RED_CROSS_990,
        return_id: "24433471",
        form_type: "990",
        tax_period: "2025-06",
        tax_year: 2024,
        mission:
          "THE AMERICAN RED CROSS PREVENTS AND ALLEVIATES HUMAN SUFFERING IN THE FACE OF EMERGENCIES BY MOBILIZING THE POWER OF VOLUNTEERS AND THE GENEROSITY OF DONORS.",
        website: "WWW.REDCROSS.ORG",
        total_revenue: 3_916_983_933,
        total_expenses: 3_285_857_544,
        total_assets_eoy: 5_052_941_623,
        source: "efile_xml",
        file_url: `${base}/xml/2026/2026_TEOS_XML_03A.zip`,
        released_at: "2026-09-16T13:02:21.000Z",
        row_count: 2,
      },
    ]);
  });

  test("stores its top 3 programs by expense", async () => {
    const rows = await query(
      d1,
      `SELECT object_id, rank, substr(description, 1, 20) AS description, expense, grants, revenue
      FROM programs WHERE ein = '530196605' ORDER BY rank`,
    );
    expect(rows).toStrictEqual([
      {
        object_id: RED_CROSS_990,
        rank: 1,
        description: "BIOMEDICAL SERVICES ",
        expense: 2_119_409_244,
        grants: 0,
        revenue: 2_305_214_618,
      },
      {
        object_id: RED_CROSS_990,
        rank: 2,
        description: "DOMESTIC DISASTER SE",
        expense: 591_737_244,
        grants: 231_002_736,
        revenue: 0,
      },
      {
        object_id: RED_CROSS_990,
        rank: 3,
        description: "TRAINING SERVICES: T",
        expense: 143_102_303,
        grants: 1_063_370,
        revenue: 175_384_737,
      },
    ]);
  });

  test("stores a 990-PF's filing facts under a nameless org for an EIN no other source lists", async () => {
    const rows = await query(
      d1,
      `SELECT o.name, o.bmf_run_id, f.object_id, f.form_type, f.tax_period, f.tax_year, f.mission, f.total_revenue,
        (SELECT count(*) FROM programs p WHERE p.ein = o.ein) AS programs
      FROM orgs o JOIN filings f ON f.ein = o.ein WHERE o.ein = '934054155'`,
    );
    expect(rows).toStrictEqual([
      {
        name: null,
        bmf_run_id: null,
        object_id: PF,
        form_type: "990-PF",
        tax_period: "2024-12",
        tax_year: 2024,
        mission: null,
        total_revenue: null,
        programs: 0,
      },
    ]);
  });

  test("stores no filing from another batch", async () => {
    expect(Object.keys(await storedFilings(d1))).toEqual([
      "530196605",
      "934054155",
    ]);
  });

  test("records each year's index as a run with its row count", async () => {
    const rows = await query(
      d1,
      "SELECT file_url, row_count FROM import_runs WHERE source = 'efile_index' ORDER BY id",
    );
    expect(rows).toStrictEqual([
      { file_url: `${base}/xml/2026/index_2026.csv`, row_count: 9 },
      { file_url: `${base}/xml/2025/index_2025.csv`, row_count: 3 },
      { file_url: `${base}/xml/2024/index_2024.csv`, row_count: 6 },
    ]);
  });

  test("leaves no batch zip on disk", async () => {
    expect(await readdir(join(work, "batches"))).toEqual([]);
  });
});

describe("importing a second batch", { timeout: 60_000 }, () => {
  test("adds its filings and keeps the first batch's", async () => {
    const d1 = await d1WithBmf("two-batches");
    await loadEfile(d1, { batches: ["2026_TEOS_XML_03A"] });
    await loadEfile(d1, { batches: ["2026_TEOS_XML_02A"] });
    expect(await storedFilings(d1)).toStrictEqual({
      "530196605": [RED_CROSS_990, "2026_TEOS_XML_03A.zip"],
      "920724925": [DELTA_TRITON_NEW, "2026_TEOS_XML_02A.zip"],
      "934054155": [PF, "2026_TEOS_XML_03A.zip"],
    });
  });
});

describe("a full run after an earlier one", { timeout: 60_000 }, () => {
  let d1: string;

  beforeAll(async () => {
    d1 = await d1WithBmf("full");
    await loadEfile(d1, { baseUrl: `${base}/older/` });
    await loadEfile(d1);
  }, 120_000);

  test("stores every EIN's latest filing, from a batch's second zip, a lowercase batch id and a prefixed return too", async () => {
    expect(await storedFilings(d1)).toStrictEqual({
      "131520977": ["202630139349301998", "2026_TEOS_XML_01A.zip"],
      "203349625": ["202620149349301082", "2026_TEOS_XML_01A.zip"],
      "394993812": [IN_SECOND_ZIP, "2026_TEOS_XML_05B.zip"],
      "470269340": [LOWERCASE_BATCH, "2024_TEOS_XML_05A.zip"],
      "530196605": [RED_CROSS_990, "2026_TEOS_XML_03A.zip"],
      "920724925": [DELTA_TRITON_NEW, "2026_TEOS_XML_02A.zip"],
      "934054155": [PF, "2026_TEOS_XML_03A.zip"],
      "992834231": [PREFIXED, "2026_TEOS_XML_06A.zip"],
    });
  });

  test("replaces a superseded filing's programs with the new one's", async () => {
    const rows = await query(
      d1,
      "SELECT object_id, rank, description FROM programs WHERE ein = '920724925' AND rank = 1",
    );
    expect(rows).toStrictEqual([
      {
        object_id: DELTA_TRITON_NEW,
        rank: 1,
        description:
          "Phi Sigma Kappa Delta Triton has been suspended from Purdues campus. They anticipate to return in one year.",
      },
    ]);
  });

  test("deletes the filing and programs of an EIN the indexes no longer list", async () => {
    const rows = await query(
      d1,
      "SELECT (SELECT count(*) FROM filings WHERE ein = '813192688') AS filings, (SELECT count(*) FROM programs WHERE ein = '813192688') AS programs",
    );
    expect(rows).toStrictEqual([{ filings: 0, programs: 0 }]);
  });
});

describe("a run that loads nothing", { timeout: 60_000 }, () => {
  let d1: string;

  beforeAll(async () => {
    d1 = await d1WithBmf("aborted");
  }, 60_000);

  async function expectNothingLoaded(out: string): Promise<void> {
    expect(
      await query(
        d1,
        "SELECT (SELECT count(*) FROM filings) AS filings, (SELECT count(*) FROM import_runs WHERE source LIKE 'efile%') AS runs",
      ),
    ).toStrictEqual([{ filings: 0, runs: 0 }]);
    await expect(access(out)).rejects.toThrow();
  }

  test("falls below the yield floor, naming the yields", async () => {
    const out = join(work, "drifted.load.sql");
    await expect(
      loadEfile(d1, { baseUrl: `${base}/drifted/`, out }),
    ).rejects.toThrow(
      "990 import aborted: of 1 Form 990s, 0.0% state a mission and 0.0% a total revenue, below the floor of 90.0% and 90.0%; nothing was loaded",
    );
    await expectNothingLoaded(out);
  });

  test("misses a latest filing in every zip of its batch, naming it", async () => {
    const out = join(work, "missing.load.sql");
    await expect(
      loadEfile(d1, { baseUrl: `${base}/missing/`, out }),
    ).rejects.toThrow(
      `990 import aborted: 1 latest filings listed in batch 2026_TEOS_XML_06* are in none of its zips (${PREFIXED}); nothing was loaded`,
    );
    await expectNothingLoaded(out);
  });

  test("names a batch holding no latest filing", async () => {
    const out = join(work, "unlisted.load.sql");
    await expect(
      loadEfile(d1, { batches: ["2026_TEOS_XML_04A"], out }),
    ).rejects.toThrow(
      "990 import aborted: no latest filing is listed in a batch 2026_TEOS_XML_04*; nothing was loaded",
    );
    await expectNothingLoaded(out);
  });
});

test("the release years read are the current one and the two before it", () => {
  expect(releaseYears(new Date("2026-10-03T12:00:00Z"))).toEqual([
    2026, 2025, 2024,
  ]);
  expect(releaseYears(new Date("2027-01-01T00:00:00Z"))).toEqual([
    2027, 2026, 2025,
  ]);
});
