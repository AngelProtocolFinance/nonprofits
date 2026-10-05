import { randomBytes } from "node:crypto";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { importBmf } from "./bmf.ts";
import {
  type EfileFloors,
  type EfileImportOptions,
  importEfile,
} from "./efile.ts";
import {
  loadTarget,
  query,
  quickRetry,
  type Route,
  resetDataDb,
  serve,
} from "./test-support.ts";

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

/** The only 2024v5.0 Form 990 in the fixture indexes. */
const V2024_5_0 = "202630139349301998";
/** A 990-EZ and a 990-PF, both in batch 01A. */
const EZ = "202630139349200908";
const PF_01A = "202630139349100013";
/** A 990-EZ in batch 01A whose mission reads only "SEE SCHEDULE O"; only the schedule-o route lists it. */
const EZ_SCHEDULE_O = "202640199349200804";

/** Which fixture returns each batch zip holds, as served for both index variants. */
const ZIPS: Record<string, string[]> = {
  "2026_TEOS_XML_01A": [V2024_5_0, "202620149349301082", EZ, PF_01A],
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

/** A batch zip of fixture returns `objectIds`, those in `replaced` as given there. */
async function batchZipWith(
  objectIds: readonly string[],
  replaced: Record<string, string>,
): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const id of objectIds) {
    const xml = replaced[id];
    files[`${id}_public.xml`] =
      xml === undefined
        ? await fixture(`xml/${id}_public.xml`)
        : Buffer.from(xml);
  }
  return zip(files);
}

/** `zipped` with its first entry's compressed bytes overwritten partway in. */
function corruptFirstEntry(zipped: Uint8Array): Uint8Array {
  const bytes = Uint8Array.from(zipped);
  const header = new DataView(bytes.buffer);
  // a local file header is 30 bytes, then its name and extra field
  const data = 30 + header.getUint16(26, true) + header.getUint16(28, true);
  bytes.fill(0xff, data + 64, data + 96);
  return bytes;
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
  // the newest index under half the prior year's rows (thin), or exactly half
  const header = (await fixture("index_2026.csv"))
    .toString("utf8")
    .split("\r\n")[0];
  routes.set("/thin/2027/index_2027.csv", `${header}\r\n`);
  routes.set("/half/2023/index_2023.csv", `${header}\r\n`);
  for (const year of YEARS) {
    const index = (await fixture(`index_${year}.csv`)).toString("utf8");
    routes.set(`/thin/${year}/index_${year}.csv`, index);
    // Delta Triton's 2024 filing, its latest without the 2026 index, moved out of 05A
    routes.set(
      `/half/${year}/index_${year}.csv`,
      index.replace(
        ",202441319349301889,2024_TEOS_XML_05a",
        ",202441319349301889,2024_TEOS_XML_06A",
      ),
    );
  }
  // apps.irs.gov answers an unpublished year with a 302 to its not-found page
  routes.set("/redirected/2027/index_2027.csv", (res) => {
    res.writeHead(302, { location: "/404" }).end();
  });
  routes.set("/404", "<html><body>Page not found</body></html>");
  for (const year of YEARS) {
    routes.set(
      `/redirected/${year}/index_${year}.csv`,
      await fixture(`index_${year}.csv`),
    );
  }
  routes.set(
    "/redirected/2026/2026_TEOS_XML_03A.zip",
    await batchZip(ZIPS["2026_TEOS_XML_03A"] ?? []),
  );
  // the 2026 index answered 503 once, the 03A zip cut off mid-body once
  const flaky = { index: 0, zip: 0 };
  const index2026 = await fixture("index_2026.csv");
  routes.set("/flaky/2026/index_2026.csv", (res) => {
    if (flaky.index++ === 0) res.writeHead(503).end();
    else res.writeHead(200, { "last-modified": RELEASED }).end(index2026);
  });
  for (const year of [2025, 2024]) {
    routes.set(
      `/flaky/${year}/index_${year}.csv`,
      await fixture(`index_${year}.csv`),
    );
  }
  const zip03A = await batchZip(ZIPS["2026_TEOS_XML_03A"] ?? []);
  routes.set("/flaky/2026/2026_TEOS_XML_03A.zip", (res) => {
    res.writeHead(200, {
      "last-modified": RELEASED,
      "content-length": zip03A.length,
    });
    if (flaky.zip++ === 0) {
      res.write(zip03A.subarray(0, zip03A.length / 2), () =>
        res.socket?.destroy(),
      );
    } else res.end(zip03A);
  });
  for (const route of ["thin", "half"]) {
    routes.set(
      `/${route}/2024/2024_TEOS_XML_05A.zip`,
      await batchZip([LOWERCASE_BATCH]),
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
  // a run with three returns rejected: one listed under the wrong EIN, a 990 and a 990-EZ with a cents amount,
  // the 990 beside its runner-up
  for (const year of YEARS) {
    const index = (await fixture(`index_${year}.csv`)).toString("utf8");
    routes.set(
      `/rejecting/${year}/index_${year}.csv`,
      index.replace(",203349625,", ",203349626,"),
    );
    routes.set(`/version-drift/${year}/index_${year}.csv`, index);
    routes.set(
      `/schedule-o/${year}/index_${year}.csv`,
      year === 2026
        ? `${index}24039646,EFILE,310899051,202412,2026,COMMUNITY IMPROVEMENT CORP OF NOBLE COUNTY,990EZ,93492019008046,${EZ_SCHEDULE_O},2026_TEOS_XML_01A\r\n`
        : index,
    );
    // every 990 row under a code the import doesn't know
    routes.set(
      `/renamed-990/${year}/index_${year}.csv`,
      index.replaceAll(",990,", ",990X,"),
    );
    // a return type the IRS might add to the index
    routes.set(
      `/new-type/${year}/index_${year}.csv`,
      year === 2026
        ? `${index}24999999,EFILE,123456789,202512,2026,A NEW FILER,990X,93499999999999,202699999349999999,2026_TEOS_XML_03A\r\n`
        : index,
    );
  }
  // the Red Cross's return with a schedule after its form that is never closed and, incompressible, spans
  // many of the zip's chunks: reading it through would reject the return as unreadable
  const redCross = (await fixture(`xml/${RED_CROSS_990}_public.xml`)).toString(
    "utf8",
  );
  const padded = redCross.replace(
    "</IRS990>",
    `</IRS990><IRS990ScheduleO><Explanation>${randomBytes(600_000).toString("base64")}`,
  );
  for (const year of YEARS) {
    routes.set(
      `/padded/${year}/index_${year}.csv`,
      await fixture(`index_${year}.csv`),
    );
  }
  routes.set(
    "/padded/2026/2026_TEOS_XML_03A.zip",
    zip({
      [`${RED_CROSS_990}_public.xml`]: Buffer.from(padded),
      [`${PF}_public.xml`]: await fixture(`xml/${PF}_public.xml`),
    }),
  );
  // the 2026 index with one EIN cut to 8 digits; the 990-PF the index lists as a 990-EZ
  for (const year of YEARS) {
    const index = (await fixture(`index_${year}.csv`)).toString("utf8");
    routes.set(
      `/layout-drift/${year}/index_${year}.csv`,
      year === 2026 ? index.replace(",203349625,", ",20334962,") : index,
    );
    routes.set(
      `/form-mismatch/${year}/index_${year}.csv`,
      index.replace(",990PF,93491013000136,", ",990EZ,93491013000136,"),
    );
  }
  const cents = (await fixture(`xml/${DELTA_TRITON_NEW}_public.xml`))
    .toString("utf8")
    .replace("<CYTotalRevenueAmt>42888<", "<CYTotalRevenueAmt>42888.50<");
  const ezCents = (await fixture(`xml/${EZ}_public.xml`))
    .toString("utf8")
    .replace("<TotalRevenueAmt>81241<", "<TotalRevenueAmt>81241.50<");
  for (const [batch, objectIds] of Object.entries(ZIPS)) {
    const path = `${batch.slice(0, 4)}/${batch}.zip`;
    const zipped = await batchZip(objectIds);
    routes.set(`/version-drift/${path}`, zipped);
    routes.set(`/form-mismatch/${path}`, zipped);
    routes.set(`/new-type/${path}`, zipped);
    routes.set(`/renamed-990/${path}`, zipped);
    routes.set(
      `/schedule-o/${path}`,
      batch === "2026_TEOS_XML_01A"
        ? await batchZip([...objectIds, EZ_SCHEDULE_O])
        : zipped,
    );
    routes.set(
      `/rejecting/${path}`,
      batch === "2026_TEOS_XML_02A"
        ? zip({
            [`${DELTA_TRITON_NEW}_public.xml`]: Buffer.from(cents),
            [`${DELTA_TRITON_OLD}_public.xml`]: await fixture(
              `xml/${DELTA_TRITON_OLD}_public.xml`,
            ),
          })
        : batch === "2026_TEOS_XML_01A"
          ? await batchZipWith(objectIds, { [EZ]: ezCents })
          : zipped,
    );
  }
  // Delta Triton's latest 990 with a cents amount, beside its runner-up: as
  // read (fallback), or unreadable too (no-fallback); the 990-EZ malformed
  const ezMalformed = (await fixture(`xml/${EZ}_public.xml`))
    .toString("utf8")
    .replace("</PrimaryExemptPurposeTxt>", "</PrimaryPurpose>");
  const centsBesideRunnerUp = await batchZipWith(
    ZIPS["2026_TEOS_XML_02A"] ?? [],
    { [DELTA_TRITON_NEW]: cents },
  );
  for (const route of ["fallback", "no-fallback"]) {
    for (const year of YEARS) {
      routes.set(
        `/${route}/${year}/index_${year}.csv`,
        await fixture(`index_${year}.csv`),
      );
    }
    for (const [batch, objectIds] of Object.entries(ZIPS)) {
      routes.set(
        `/${route}/${batch.slice(0, 4)}/${batch}.zip`,
        await batchZip(objectIds),
      );
    }
  }
  routes.set(
    "/fallback/2026/2026_TEOS_XML_01A.zip",
    await batchZipWith(ZIPS["2026_TEOS_XML_01A"] ?? [], { [EZ]: ezMalformed }),
  );
  routes.set("/fallback/2026/2026_TEOS_XML_02A.zip", centsBesideRunnerUp);
  routes.set(
    "/no-fallback/2026/2026_TEOS_XML_02A.zip",
    corruptFirstEntry(centsBesideRunnerUp),
  );
  // the one 2024v5.0 return, its mission and revenue elements renamed
  routes.set(
    "/version-drift/2026/2026_TEOS_XML_01A.zip",
    await batchZipWith(ZIPS["2026_TEOS_XML_01A"] ?? [], {
      [V2024_5_0]: (await fixture(`xml/${V2024_5_0}_public.xml`))
        .toString("utf8")
        .replaceAll("MissionDesc>", "MissionStatementTxt>")
        .replaceAll("CYTotalRevenueAmt>", "CurrentYearTotalRevenueAmt>"),
    }),
  );
  // the 990-EZ with its mission and revenue elements renamed, and the 2023v6.0 990-PF with its revenue's
  for (const year of YEARS) {
    routes.set(
      `/form-drift/${year}/index_${year}.csv`,
      await fixture(`index_${year}.csv`),
    );
  }
  for (const [batch, objectIds] of Object.entries(ZIPS)) {
    routes.set(
      `/form-drift/${batch.slice(0, 4)}/${batch}.zip`,
      await batchZip(objectIds),
    );
  }
  routes.set(
    "/form-drift/2026/2026_TEOS_XML_01A.zip",
    await batchZipWith(ZIPS["2026_TEOS_XML_01A"] ?? [], {
      [EZ]: (await fixture(`xml/${EZ}_public.xml`))
        .toString("utf8")
        .replaceAll("PrimaryExemptPurposeTxt>", "PrimaryPurposeTxt>")
        .replaceAll("<TotalRevenueAmt>", "<RevenueTotalAmt>")
        .replaceAll("</TotalRevenueAmt>", "</RevenueTotalAmt>"),
      [PF_01A]: (await fixture(`xml/${PF_01A}_public.xml`))
        .toString("utf8")
        .replaceAll("TotalRevAndExpnssAmt>", "TotalRevenueAmt>"),
    }),
  );
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

/** The directory of a new data file under `work`, loaded with the BMF fixture. */
async function dataDirWithBmf(name: string): Promise<string> {
  const dataDir = join(work, name);
  await resetDataDb(dataDir);
  await importBmf({
    urls: BMF_FILES.map((file) => `${base}/${file}`),
    minOrgs: 1,
    out: join(work, `${name}-bmf.load.sql`),
    target: loadTarget(dataDir),
  });
  return dataDir;
}

/** Every form's yield floors at `share`. */
function floorsAt(
  share: number,
  rest: Pick<EfileFloors, "versionFrom" | "rejects">,
): EfileFloors {
  return {
    "990": { mission: share, revenue: share },
    "990-EZ": { mission: share, finances: share },
    "990-PF": { finances: share },
    ...rest,
  };
}

function loadEfile(dataDir: string, options: Partial<EfileImportOptions> = {}) {
  return importEfile({
    baseUrl: `${base}/xml/`,
    latestYear: 2026,
    floors: floorsAt(0.9, { versionFrom: 200, rejects: 0.01 }),
    workDir: join(work, "batches"),
    out: join(work, "efile.load.sql"),
    target: loadTarget(dataDir),
    retry: quickRetry(),
    ...options,
  });
}

/** Each stored filing's object id and the zip its run cites, by EIN. */
async function storedFilings(
  dir: string,
): Promise<Record<string, [string, string]>> {
  const rows = await query<{
    ein: string;
    object_id: string;
    file_url: string;
  }>(
    dir,
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
  let dir: string;

  beforeAll(async () => {
    dir = await dataDirWithBmf("red-cross");
    await loadEfile(dir, { batches: ["2026_TEOS_XML_03A"] });
  }, 120_000);

  test("stores its filing facts, citing the batch zip it came from", async () => {
    const rows = await query(
      dir,
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
      dir,
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
      dir,
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
        total_revenue: 0,
        programs: 0,
      },
    ]);
  });

  test("stores no filing from another batch", async () => {
    expect(Object.keys(await storedFilings(dir))).toEqual([
      "530196605",
      "934054155",
    ]);
  });

  test("records each year's index as a run with its row count", async () => {
    const rows = await query(
      dir,
      "SELECT file_url, row_count FROM import_runs WHERE source = 'efile_index' ORDER BY id",
    );
    expect(rows).toStrictEqual([
      { file_url: `${base}/xml/2026/index_2026.csv`, row_count: 11 },
      { file_url: `${base}/xml/2025/index_2025.csv`, row_count: 3 },
      { file_url: `${base}/xml/2024/index_2024.csv`, row_count: 6 },
    ]);
  });

  test("leaves no batch zip on disk", async () => {
    expect(await readdir(join(work, "batches"))).toEqual([]);
  });
});

describe("importing a batch holding a 990-EZ and a 990-PF", {
  timeout: 60_000,
}, () => {
  let dir: string;

  beforeAll(async () => {
    dir = await dataDirWithBmf("ez-pf");
    await loadEfile(dir, { batches: ["2026_TEOS_XML_01A"] });
  }, 120_000);

  async function storedFiling(ein: string) {
    return query(
      dir,
      `SELECT f.object_id, f.form_type, f.tax_period, f.tax_year, f.mission, f.activity_summary, f.website,
        f.total_revenue, f.total_expenses, f.total_assets_eoy, r.file_url,
        (SELECT count(*) FROM programs p WHERE p.ein = f.ein) AS programs
      FROM filings f JOIN import_runs r ON r.id = f.run_id WHERE f.ein = '${ein}'`,
    );
  }

  test("stores the 990-EZ's primary exempt purpose as its mission, with its website, finances and top 3 programs", async () => {
    expect(await storedFiling("316050644")).toStrictEqual([
      {
        object_id: EZ,
        form_type: "990-EZ",
        tax_period: "2025-09",
        tax_year: 2024,
        mission: "Assist statewide youth through optimism and public service",
        activity_summary: null,
        website: "ohiodistrictoptimist.org",
        total_revenue: 81_241,
        total_expenses: 92_012,
        total_assets_eoy: 39_111,
        file_url: `${base}/xml/2026/2026_TEOS_XML_01A.zip`,
        programs: 3,
      },
    ]);
  });

  test("stores the 990-PF's filing facts, website and finances, with no mission", async () => {
    expect(await storedFiling("920372947")).toStrictEqual([
      {
        object_id: PF_01A,
        form_type: "990-PF",
        tax_period: "2024-08",
        tax_year: 2023,
        mission: null,
        activity_summary: null,
        website: "https://www.flipcause.com/secure/cause_pdetai",
        total_revenue: 4_136,
        total_expenses: 7_856,
        total_assets_eoy: 7_478,
        file_url: `${base}/xml/2026/2026_TEOS_XML_01A.zip`,
        programs: 0,
      },
    ]);
  });
});

describe("importing a filing whose mission only points to Schedule O", {
  timeout: 60_000,
}, () => {
  const scheduleO = () => ({
    baseUrl: `${base}/schedule-o/`,
    batches: ["2026_TEOS_XML_01A"],
  });
  let dir: string;
  let summary: Awaited<ReturnType<typeof importEfile>>;

  beforeAll(async () => {
    dir = await dataDirWithBmf("schedule-o");
    summary = await loadEfile(dir, {
      ...scheduleO(),
      // one of the two 990-EZs states no mission
      floors: floorsAt(0.5, { versionFrom: 200, rejects: 0.01 }),
    });
  }, 60_000);

  test("flags it, and not a filing stating its mission", async () => {
    expect(
      await query(
        dir,
        "SELECT ein, mission, mission_on_schedule_o FROM filings WHERE ein IN ('310899051', '316050644') ORDER BY ein",
      ),
    ).toStrictEqual([
      { ein: "310899051", mission: null, mission_on_schedule_o: 1 },
      {
        ein: "316050644",
        mission: "Assist statewide youth through optimism and public service",
        mission_on_schedule_o: 0,
      },
    ]);
  });

  test("counts it as stating no mission: half the run's 990-EZs", () => {
    expect(summary.returns["990-EZ"]).toBe(2);
    expect(summary.yields["990-EZ"]?.mission).toBe(0.5);
  });

  test("aborts the run when the mission floor is above that share, loading nothing", async () => {
    const empty = await dataDirWithBmf("schedule-o-floor");
    const out = join(work, "schedule-o-floor.load.sql");
    const floors: EfileFloors = {
      ...floorsAt(0, { versionFrom: 200, rejects: 0.01 }),
      "990-EZ": { mission: 0.6, finances: 0.5 },
    };

    await expect(
      loadEfile(empty, { ...scheduleO(), floors, out }),
    ).rejects.toThrow(
      "990 import aborted: of 2 990-EZs, 50.0% state a mission and 100.0% total revenue, expenses and assets, below the floor of 60.0% and 50.0%; nothing was loaded",
    );
    expect(
      await query(empty, "SELECT count(*) AS n FROM filings"),
    ).toStrictEqual([{ n: 0 }]);
    await expect(access(out)).rejects.toThrow();
  });
});

describe("importing a second batch", { timeout: 60_000 }, () => {
  test("adds its filings and keeps the first batch's", async () => {
    const dir = await dataDirWithBmf("two-batches");
    await loadEfile(dir, { batches: ["2026_TEOS_XML_03A"] });
    await loadEfile(dir, { batches: ["2026_TEOS_XML_02A"] });
    expect(await storedFilings(dir)).toStrictEqual({
      "530196605": [RED_CROSS_990, "2026_TEOS_XML_03A.zip"],
      "920724925": [DELTA_TRITON_NEW, "2026_TEOS_XML_02A.zip"],
      "934054155": [PF, "2026_TEOS_XML_03A.zip"],
    });
  });
});

describe("a full run after an earlier one", { timeout: 60_000 }, () => {
  let dir: string;

  beforeAll(async () => {
    dir = await dataDirWithBmf("full");
    await loadEfile(dir, { baseUrl: `${base}/older/` });
    await loadEfile(dir);
  }, 120_000);

  test("stores every EIN's latest filing, from a batch's second zip, a lowercase batch id and a prefixed return too", async () => {
    expect(await storedFilings(dir)).toStrictEqual({
      "131520977": ["202630139349301998", "2026_TEOS_XML_01A.zip"],
      "203349625": ["202620149349301082", "2026_TEOS_XML_01A.zip"],
      "316050644": [EZ, "2026_TEOS_XML_01A.zip"],
      "394993812": [IN_SECOND_ZIP, "2026_TEOS_XML_05B.zip"],
      "470269340": [LOWERCASE_BATCH, "2024_TEOS_XML_05A.zip"],
      "530196605": [RED_CROSS_990, "2026_TEOS_XML_03A.zip"],
      "920372947": [PF_01A, "2026_TEOS_XML_01A.zip"],
      "920724925": [DELTA_TRITON_NEW, "2026_TEOS_XML_02A.zip"],
      "934054155": [PF, "2026_TEOS_XML_03A.zip"],
      "992834231": [PREFIXED, "2026_TEOS_XML_06A.zip"],
    });
  });

  test("replaces a superseded filing's programs with the new one's", async () => {
    const rows = await query(
      dir,
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

  test("deletes the nameless org whose only fact was the dropped filing, keeping orgs with a fact or a filing", async () => {
    const rows = await query(
      dir,
      "SELECT ein FROM orgs WHERE ein IN ('813192688', '934054155', '000019818') ORDER BY ein",
    );
    // 934054155 is nameless but has a filing; 000019818 is a BMF org with no filing
    expect(rows).toStrictEqual([{ ein: "000019818" }, { ein: "934054155" }]);
  });

  test("deletes the filing and programs of an EIN the indexes no longer list", async () => {
    const rows = await query(
      dir,
      "SELECT (SELECT count(*) FROM filings WHERE ein = '813192688') AS filings, (SELECT count(*) FROM programs WHERE ein = '813192688') AS programs",
    );
    expect(rows).toStrictEqual([{ filings: 0, programs: 0 }]);
  });
});

describe("a run that loads nothing", { timeout: 60_000 }, () => {
  let dir: string;

  beforeAll(async () => {
    dir = await dataDirWithBmf("aborted");
  }, 60_000);

  async function expectNothingLoaded(out: string): Promise<void> {
    expect(
      await query(
        dir,
        "SELECT (SELECT count(*) FROM filings) AS filings, (SELECT count(*) FROM import_runs WHERE source LIKE 'efile%') AS runs",
      ),
    ).toStrictEqual([{ filings: 0, runs: 0 }]);
    await expect(access(out)).rejects.toThrow();
  }

  test("reads an index whose layout drifted, naming its row", async () => {
    const out = join(work, "layout-drift.load.sql");
    await expect(
      loadEfile(dir, { baseUrl: `${base}/layout-drift/`, out }),
    ).rejects.toThrow(
      `990 index layout changed in ${base}/layout-drift/2026/index_2026.csv: row 3: EIN is "20334962"`,
    );
    await expectNothingLoaded(out);
  });

  test("falls below the yield floor, naming the yields", async () => {
    const out = join(work, "drifted.load.sql");
    await expect(
      loadEfile(dir, { baseUrl: `${base}/drifted/`, out }),
    ).rejects.toThrow(
      "990 import aborted: of 1 Form 990s, 0.0% state a mission and 0.0% a total revenue, below the floor of 90.0% and 90.0%; nothing was loaded",
    );
    await expectNothingLoaded(out);
  });

  test("misses a latest filing in every zip of its batch, naming it", async () => {
    const out = join(work, "missing.load.sql");
    await expect(
      loadEfile(dir, { baseUrl: `${base}/missing/`, out }),
    ).rejects.toThrow(
      `990 import aborted: 1 latest filings listed in batch 2026_TEOS_XML_06* are in none of its zips (${PREFIXED}); nothing was loaded`,
    );
    await expectNothingLoaded(out);
  });

  test("rejects more than the allowed share of its filings, naming the reasons", async () => {
    const out = join(work, "rejecting.load.sql");
    await expect(
      loadEfile(dir, {
        baseUrl: `${base}/rejecting/`,
        out,
        floors: floorsAt(0.5, { versionFrom: 200, rejects: 0.01 }),
      }),
    ).rejects.toThrow(
      "990 import aborted: 3 of 10 latest filings rejected (30.0%), above the 1.0% allowed (EIN mismatch: 1, bad amount: 2); nothing was loaded",
    );
    await expectNothingLoaded(out);
  });

  test("holds a returnVersion with enough 990s to the floor, naming it", async () => {
    const out = join(work, "version-drift.load.sql");
    await expect(
      loadEfile(dir, {
        baseUrl: `${base}/version-drift/`,
        out,
        floors: floorsAt(0.5, { versionFrom: 1, rejects: 0.01 }),
      }),
    ).rejects.toThrow(
      "990 import aborted: returnVersion 2024v5.0: of 1 Form 990s, 0.0% state a mission and 0.0% a total revenue, below the floor of 50.0% and 50.0%; nothing was loaded",
    );
    await expectNothingLoaded(out);
  });

  test("falls below a 990-EZ yield floor, naming the yields", async () => {
    const out = join(work, "ez-drift.load.sql");
    await expect(
      loadEfile(dir, { baseUrl: `${base}/form-drift/`, out }),
    ).rejects.toThrow(
      "990 import aborted: of 1 990-EZs, 0.0% state a mission and 0.0% total revenue, expenses and assets, below the floor of 90.0% and 90.0%; nothing was loaded",
    );
    await expectNothingLoaded(out);
  });

  test("holds a returnVersion with enough 990-PFs to the floor, naming it", async () => {
    const out = join(work, "pf-drift.load.sql");
    await expect(
      loadEfile(dir, {
        baseUrl: `${base}/form-drift/`,
        out,
        floors: {
          ...floorsAt(0.5, { versionFrom: 1, rejects: 0.01 }),
          "990-EZ": { mission: 0, finances: 0 },
        },
      }),
    ).rejects.toThrow(
      "990 import aborted: returnVersion 2023v6.0: of 1 990-PFs, 0.0% state total revenue, expenses and assets, below the floor of 50.0%; nothing was loaded",
    );
    await expectNothingLoaded(out);
  });

  test("is a full run whose indexes list no Form 990 under a code it knows", async () => {
    const out = join(work, "renamed-990.load.sql");
    await expect(
      loadEfile(dir, { baseUrl: `${base}/renamed-990/`, out }),
    ).rejects.toThrow(
      "990 import aborted: the run selected no Form 990s, below the floor of 90.0% and 90.0%; nothing was loaded",
    );
    await expectNothingLoaded(out);
  });

  test("has a filing too large for one statement, naming it", async () => {
    const out = join(work, "oversize.load.sql");
    await expect(
      loadEfile(dir, {
        batches: ["2026_TEOS_XML_03A"],
        out,
        maxStatementBytes: 3_000,
      }),
    ).rejects.toThrow(
      /^990 return 202640829349300109 in \S+\/2026_TEOS_XML_03A\.zip needs a \d+-byte statement, over the 3000-byte budget; nothing was loaded$/,
    );
    await expectNothingLoaded(out);
  });

  test("finds neither this year's index nor last year's", async () => {
    const out = join(work, "unpublished.load.sql");
    await expect(loadEfile(dir, { latestYear: 2028, out })).rejects.toThrow(
      `990 index download failed: ${base}/xml/2027/index_2027.csv: HTTP 404`,
    );
    await expectNothingLoaded(out);
  });

  test("names a batch holding no latest filing", async () => {
    const out = join(work, "unlisted.load.sql");
    await expect(
      loadEfile(dir, { batches: ["2026_TEOS_XML_04A"], out }),
    ).rejects.toThrow(
      "990 import aborted: no latest filing is listed in a batch 2026_TEOS_XML_04*; nothing was loaded",
    );
    await expectNothingLoaded(out);
  });
});

describe("a full run with rejected returns", { timeout: 60_000 }, () => {
  let dir: string;
  let summary: Awaited<ReturnType<typeof importEfile>>;

  beforeAll(async () => {
    dir = await dataDirWithBmf("rejecting");
    await loadEfile(dir, { baseUrl: `${base}/older/` });
    summary = await loadEfile(dir, {
      baseUrl: `${base}/rejecting/`,
      floors: {
        ...floorsAt(0.5, { versionFrom: 200, rejects: 0.5 }),
        "990-EZ": { mission: 0, finances: 0 },
      },
    });
  }, 120_000);

  test("reports each rejected return by reason", () => {
    expect(summary.rejects).toStrictEqual({
      "EIN mismatch": ["202620149349301082"],
      "bad amount": [EZ, DELTA_TRITON_NEW],
    });
  });

  test("keeps the stored filing of an EIN whose latest return was rejected and has no runner-up", async () => {
    expect((await storedFilings(dir))["316050644"]).toEqual([
      EZ,
      "2026_TEOS_XML_01A.zip",
    ]);
  });

  test("counts rejected 990s against the yield floors", () => {
    // 7 Form 990s selected, the 2 rejected among them; the 5 loaded all state a mission
    expect(summary.returns["990"]).toBe(7);
    expect(summary.yields["990"]?.mission).toBeCloseTo(5 / 7);
  });

  test("counts a rejected 990-EZ against its form's floors", () => {
    expect(summary.returns["990-EZ"]).toBe(1);
    expect(summary.yields["990-EZ"]).toStrictEqual({ mission: 0, finances: 0 });
  });
});

describe("a return whose form differs from the form its index row lists", {
  timeout: 60_000,
}, () => {
  test("is rejected, and an EIN's other filings load beside it", async () => {
    const dir = await dataDirWithBmf("form-mismatch");

    const summary = await loadEfile(dir, {
      baseUrl: `${base}/form-mismatch/`,
      batches: ["2026_TEOS_XML_01A"],
      floors: {
        ...floorsAt(0.5, { versionFrom: 200, rejects: 0.5 }),
        "990-EZ": { mission: 0, finances: 0 },
      },
    });

    // listed as a 990-EZ, the return itself is a 990-PF
    expect(summary.rejects).toStrictEqual({ "form type mismatch": [PF_01A] });
    const stored = await storedFilings(dir);
    expect(stored).not.toHaveProperty("920372947");
    expect(stored).toHaveProperty("316050644");
  });
});

describe("a return followed by a schedule too large to read", {
  timeout: 60_000,
}, () => {
  test("loads from its form alone, and the zip's next return after it", async () => {
    const dir = await dataDirWithBmf("padded");

    const summary = await loadEfile(dir, {
      baseUrl: `${base}/padded/`,
      batches: ["2026_TEOS_XML_03A"],
    });

    expect(summary.rejects).toStrictEqual({});
    expect(await storedFilings(dir)).toStrictEqual({
      "530196605": [RED_CROSS_990, "2026_TEOS_XML_03A.zip"],
      "934054155": [PF, "2026_TEOS_XML_03A.zip"],
    });
  });
});

describe("a returnVersion whose 990s fall below the floor", {
  timeout: 60_000,
}, () => {
  test("loads while the version has fewer 990s than the floor applies from", async () => {
    const dir = await dataDirWithBmf("version-few");
    const summary = await loadEfile(dir, {
      baseUrl: `${base}/version-drift/`,
      floors: floorsAt(0.5, { versionFrom: 2, rejects: 0.01 }),
    });
    expect(summary.filings).toBe(10);
  });
});

describe("an index listing a return type the import doesn't store", {
  timeout: 60_000,
}, () => {
  test("counts its rows in the run summary by type, beside the 990-Ts", async () => {
    const dir = await dataDirWithBmf("new-type");
    const summary = await loadEfile(dir, {
      baseUrl: `${base}/new-type/`,
      batches: ["2026_TEOS_XML_03A"],
    });
    expect(summary.skipped).toStrictEqual({ "990T": 3, "990X": 1 });
  });
});

describe("a --batch run holding no 990-EZ", { timeout: 60_000 }, () => {
  test("loads, reporting no yields for that form", async () => {
    const dir = await dataDirWithBmf("no-ez");
    const summary = await loadEfile(dir, { batches: ["2026_TEOS_XML_03A"] });
    expect(summary.returns["990-EZ"]).toBe(0);
    expect(summary.yields["990-EZ"]).toBeNull();
    expect(summary.yields["990-PF"]).toStrictEqual({ finances: 1 });
  });
});

describe("a run in January, before the year's index is out", {
  timeout: 60_000,
}, () => {
  test("reads the three years before it, naming them", async () => {
    const dir = await dataDirWithBmf("january");
    const summary = await loadEfile(dir, {
      latestYear: 2027,
      batches: ["2026_TEOS_XML_03A"],
    });
    expect(summary.indexes.map((i) => i.url)).toEqual(
      YEARS.map((year) => `${base}/xml/${year}/index_${year}.csv`),
    );
    expect(summary.unpublished).toBe(2027);
    expect(Object.keys(await storedFilings(dir))).toContain("530196605");
  });

  test("takes a redirect to the not-found page as the year's index unpublished", async () => {
    const dir = await dataDirWithBmf("redirected");
    const summary = await loadEfile(dir, {
      baseUrl: `${base}/redirected/`,
      latestYear: 2027,
      batches: ["2026_TEOS_XML_03A"],
    });

    expect(summary.unpublished).toBe(2027);
    expect(summary.indexes.map((i) => i.year)).toEqual(YEARS);
  });
});

describe("a run whose downloads fail once", { timeout: 60_000 }, () => {
  test("reads the indexes again after a 503, and the zip again after a reset, saying so", async () => {
    const dir = await dataDirWithBmf("flaky");
    const retry = quickRetry();

    const summary = await loadEfile(dir, {
      baseUrl: `${base}/flaky/`,
      batches: ["2026_TEOS_XML_03A"],
      retry,
    });

    expect(summary.indexes.map((i) => i.year)).toEqual([2026, 2025, 2024]);
    expect(Object.keys(await storedFilings(dir))).toContain("530196605");
    expect(retry.lines).toHaveLength(2);
    expect(retry.lines[0]).toBe(
      `990 index read failed (990 index download failed: ${base}/flaky/2026/index_2026.csv: HTTP 503); try 2 of 3 in 0.0 s`,
    );
    expect(retry.lines[1]).toMatch(
      new RegExp(
        `^990 batch 2026_TEOS_XML_03A\\.zip failed \\(990 batch download failed: ${base}/flaky/2026/2026_TEOS_XML_03A\\.zip: .+\\); try 2 of 3 in 0\\.0 s$`,
      ),
    );
  });
});

describe("a run while the newest index is filling", { timeout: 60_000 }, () => {
  const years = (summary: Awaited<ReturnType<typeof importEfile>>) =>
    summary.indexes.map((i) => i.year);

  test("reads a fourth release year while the newest lists under half the prior year's rows, saying why", async () => {
    const dir = await dataDirWithBmf("thin");
    const summary = await loadEfile(dir, {
      baseUrl: `${base}/thin/`,
      latestYear: 2027,
      batches: ["2024_TEOS_XML_05A"],
    });

    expect(years(summary)).toEqual([2027, 2026, 2025, 2024]);
    expect(summary.windowReason).toBe(
      "index_2027.csv lists 0 rows, under half of index_2026.csv's 11: 4 release years read",
    );
    expect(Object.keys(await storedFilings(dir))).toContain("470269340");
  });

  test("reads three once the newest lists half the prior year's rows", async () => {
    const dir = await dataDirWithBmf("half");
    const summary = await loadEfile(dir, {
      baseUrl: `${base}/half/`,
      latestYear: 2025,
      batches: ["2024_TEOS_XML_05A"],
    });

    expect(years(summary)).toEqual([2025, 2024, 2023]);
    expect(summary.windowReason).toBe(
      "index_2025.csv lists 3 rows, at least half of index_2024.csv's 6: 3 release years read",
    );
  });
});

describe("a run into an empty data file rejecting an EIN's latest return", {
  timeout: 60_000,
}, () => {
  const floors = {
    ...floorsAt(0.5, { versionFrom: 200, rejects: 0.5 }),
    "990-EZ": { mission: 0, finances: 0 },
  };
  let dir: string;
  let summary: Awaited<ReturnType<typeof importEfile>>;

  beforeAll(async () => {
    dir = await dataDirWithBmf("fallback");
    summary = await loadEfile(dir, { baseUrl: `${base}/fallback/`, floors });
  }, 60_000);

  test("rejects an unreadable return on its own, beside one with a bad amount", () => {
    expect(summary.rejects).toStrictEqual({
      "bad amount": [DELTA_TRITON_NEW],
      unreadable: [EZ],
    });
  });

  test("stores the runner-up filing and its programs instead", async () => {
    expect(summary.runnersUp).toStrictEqual({ loaded: 1, rejects: {} });
    expect((await storedFilings(dir))["920724925"]).toEqual([
      DELTA_TRITON_OLD,
      "2026_TEOS_XML_02A.zip",
    ]);
    expect(
      await query(
        dir,
        "SELECT DISTINCT object_id FROM programs WHERE ein = '920724925'",
      ),
    ).toStrictEqual([{ object_id: DELTA_TRITON_OLD }]);
  });

  test("stores nothing for an EIN with no runner-up", async () => {
    expect(await storedFilings(dir)).not.toHaveProperty("316050644");
  });

  test("stores nothing when the runner-up's zip entry is unreadable too", async () => {
    const empty = await dataDirWithBmf("no-fallback");
    const run = await loadEfile(empty, {
      baseUrl: `${base}/no-fallback/`,
      floors,
    });
    expect(run.rejects).toStrictEqual({ "bad amount": [DELTA_TRITON_NEW] });
    expect(run.runnersUp).toStrictEqual({
      loaded: 0,
      rejects: { unreadable: [DELTA_TRITON_OLD] },
    });
    expect(await storedFilings(empty)).not.toHaveProperty("920724925");
  });
});
