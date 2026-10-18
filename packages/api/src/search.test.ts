import type { Client, InStatement } from "@libsql/client";
import type { OrgSearchResponse, SourceFile } from "@nonprofits/core";
import { FILING_SIZE_INDEX } from "@nonprofits/db";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { searchMatchPlan, searchNames } from "./org-searcher.ts";
import { freshClient, type TestApi, testApi } from "./test-support.ts";

/** The fixture's BMF file, which lists the Red Cross. */
const BMF_DC: SourceFile = {
  file: "https://www.irs.gov/pub/irs-soi/eo_dc.csv",
  releasedAt: "2026-09-08T12:00:00.000Z",
  fetchedAt: "2026-09-10T03:00:00.000Z",
};

/** A later BMF region file, so a match citing the newest BMF run instead of its own shows. */
const BMF_EO3: SourceFile = {
  file: "https://www.irs.gov/pub/irs-soi/eo3.csv",
  releasedAt: "2026-09-08T12:00:00.000Z",
  fetchedAt: "2026-09-10T03:02:00.000Z",
};

const PUB78: SourceFile = {
  file: "https://apps.irs.gov/pub/epostcard/data-download-pub78.zip",
  releasedAt: "2026-09-01T12:00:00.000Z",
  fetchedAt: "2026-09-10T03:05:00.000Z",
};

const REVOCATION: SourceFile = {
  file: "https://apps.irs.gov/pub/epostcard/data-download-revocation.zip",
  releasedAt: "2026-09-02T12:00:00.000Z",
  fetchedAt: "2026-09-10T03:06:00.000Z",
};

/** Provenance for a match the revocation list does not date. */
function openRevocation(
  is501c3: SourceFile | null,
  deductible: SourceFile | null,
) {
  return {
    is501c3,
    deductible,
    revoked: REVOCATION,
    revocationDate: null,
  };
}

/**
 * Names beside the seeded AMERICAN NATIONAL RED CROSS (in the BMF, in Pub 78)
 * that hold its words; each scores at least as well on words alone.
 */
const NEAR_MISSES = [
  // in the BMF as a 501(c)(4), not in Pub 78
  { ein: "581771391", name: "RED CROSS CIVITANS", subsection: "04" },
  // a chapter the BMF no longer lists
  { ein: "362276983", name: "AMERICAN RED CROSS", subsection: null },
  {
    ein: "841189480",
    name: "RED MOUNTAIN CROSS PRESERVATION ASSOCIATION",
    subsection: null,
  },
  {
    ein: "620646012",
    name: "ST JUDE CHILDRENS RESEARCH HOSPITAL INC",
    subsection: null,
  },
];

const RED_CROSS_ORDER = ["530196605", "581771391", "362276983", "841189480"];

/** The near misses, listed in the BMF's eo3 file, beside the fixture's Red Cross, in the orgs and the search index. */
async function nearMisses(data: Client) {
  await data.batch(
    [
      {
        sql: "INSERT INTO import_runs VALUES (6, 'bmf', ?1, ?2, ?3, 1)",
        args: [BMF_EO3.file, BMF_EO3.releasedAt, BMF_EO3.fetchedAt],
      },
      ...NEAR_MISSES.flatMap(({ ein, name, subsection }) => [
        {
          sql: "INSERT INTO orgs (ein, name, name_run_id, subsection, bmf_run_id) VALUES (?1, ?2, 1, ?3, iif(?3 IS NULL, NULL, 6))",
          args: [ein, name, subsection],
        },
        {
          sql: "INSERT INTO orgs_fts (rowid, name) VALUES (CAST(?1 AS INTEGER), ?2)",
          args: [ein, name],
        },
      ]),
    ],
    "write",
  );
}

let api: TestApi;

beforeAll(async () => {
  api = await testApi({ fill: nearMisses });
});

afterAll(async () => {
  await api.dispose();
});

/** Each from its own client, so no request here meets another's quota. */
function search(query: string, method = "GET") {
  return api.app.request(`/v1/search?${query}`, {
    method,
    headers: freshClient(),
  });
}

describe("GET /v1/search", () => {
  test("ranks the Red Cross above names that only share its words, each citing its BMF and Pub 78 files", async () => {
    const response = await search("q=red%20cross");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect((await response.json()) as OrgSearchResponse).toStrictEqual({
      query: "red cross",
      limit: 10,
      results: [
        {
          ein: "530196605",
          name: "AMERICAN NATIONAL RED CROSS",
          city: "WASHINGTON",
          state: "DC",
          is501c3: true,
          deductible: true,
          revoked: false,
          revocationDate: null,
          provenance: openRevocation(BMF_DC, PUB78),
        },
        {
          ein: "581771391",
          name: "RED CROSS CIVITANS",
          city: null,
          state: null,
          is501c3: false,
          deductible: false,
          revoked: false,
          revocationDate: null,
          provenance: openRevocation(BMF_EO3, PUB78),
        },
        {
          ein: "362276983",
          name: "AMERICAN RED CROSS",
          city: null,
          state: null,
          is501c3: null,
          deductible: false,
          revoked: false,
          revocationDate: null,
          provenance: openRevocation(null, PUB78),
        },
        {
          ein: "841189480",
          name: "RED MOUNTAIN CROSS PRESERVATION ASSOCIATION",
          city: null,
          state: null,
          is501c3: null,
          deductible: false,
          revoked: false,
          revocationDate: null,
          provenance: openRevocation(null, PUB78),
        },
      ],
    });
  });

  test.each(["q=", "q=%20%20", "q=a", "", "q=%22", "q=*"])(
    "refuses %j as too short with a 400 naming the rule",
    async (query) => {
      const response = await search(query);
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe(
        "application/problem+json",
      );
      expect(await response.json()).toStrictEqual({
        type: "about:blank",
        title: "Bad Request",
        status: 400,
        code: "invalid_query",
        detail:
          'Search query must be at least 2 characters, not counting surrounding spaces, e.g. "red cross".',
      });
    },
  );

  test.each([
    ['"red', "red"],
    ["AND OR", "AND OR"],
    ["red OR", "red OR"],
    ["NEAR(red cross)", "NEAR red cross"],
    ["-red", "red"],
    ["^red", "red"],
    ["name:red", "name red"],
    ["red*", "red"],
    ["{red cross}", "red cross"],
  ])(
    "answers FTS syntax %j as the plain words %j, never a 5xx",
    async (q, words) => {
      const response = await search(`q=${encodeURIComponent(q)}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as OrgSearchResponse;
      expect(body.query).toBe(words);
      expect(Array.isArray(body.results)).toBe(true);
    },
  );

  test.each(["**", '"" ""', "''"])(
    "refuses %j, which holds no word, with a 400",
    async (q) => {
      const response = await search(`q=${encodeURIComponent(q)}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "invalid_query",
        detail:
          'Search query must hold a word of letters or digits, e.g. "red cross".',
      });
    },
  );

  test("refuses a query over 200 characters with a 400", async () => {
    const response = await search(`q=${"red%20".repeat(50)}cross`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "invalid_query",
      detail:
        "Search query must be at most 200 characters: send a few distinctive words of the name.",
    });
  });

  test("searches a repeated word once", async () => {
    const response = await search(`q=${"inc%20".repeat(30)}red%20cross`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as OrgSearchResponse;
    expect(body.query).toBe("inc red cross");
  });

  test("reads an FTS operator as a word to match, not as syntax", async () => {
    const response = await search(`q=${encodeURIComponent("NEAR(red cross)")}`);
    const body = (await response.json()) as OrgSearchResponse;
    expect(body.results).toEqual([]);
  });

  test("still matches the words around a stray quote", async () => {
    const response = await search(`q=${encodeURIComponent('"red cross')}`);
    const body = (await response.json()) as OrgSearchResponse;
    expect(body.results.map((r) => r.ein)).toEqual(RED_CROSS_ORDER);
  });

  test("matches a possessive against the BMF's apostrophe-free spelling", async () => {
    const response = await search(
      `q=${encodeURIComponent("st jude children's")}`,
    );
    const body = (await response.json()) as OrgSearchResponse;
    expect(body.results.map((r) => r.ein)).toEqual(["620646012"]);
  });

  test("caps a limit above the max and states the limit applied", async () => {
    const response = await search("q=red%20cross&limit=500");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ limit: 50 });
  });

  test("returns at most limit matches, best first", async () => {
    const response = await search("q=red%20cross&limit=1");
    const body = (await response.json()) as OrgSearchResponse;
    expect(body.limit).toBe(1);
    expect(body.results.map((r) => r.ein)).toEqual(["530196605"]);
  });

  test.each([
    "limit=abc",
    "limit=0",
    "limit=",
    "limit=2.5",
    "limit=1e1",
    "limit=%2B5",
    "limit=%205",
    "limit=0x10",
  ])("refuses %j with a 400 naming the range", async (limit) => {
    const response = await search(`q=red%20cross&${limit}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "invalid_limit",
      detail: "limit must be a whole number from 1; above 50 is capped at 50.",
    });
  });

  test("answers 405 for a method other than GET", async () => {
    const response = await search("q=red%20cross", "POST");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("GET /v1/search before Pub 78 is imported", () => {
  let early: TestApi;

  beforeAll(async () => {
    early = await testApi({
      fill: async (data) => {
        await data.execute("DELETE FROM import_runs WHERE source = 'pub78'");
      },
    });
  });

  afterAll(async () => {
    await early.dispose();
  });

  test("answers deductible null and cites no Pub 78 file, while still citing the BMF", async () => {
    const response = await early.app.request("/v1/search?q=red%20cross", {
      headers: freshClient(),
    });
    const body = (await response.json()) as OrgSearchResponse;
    expect(body.results[0]).toMatchObject({
      ein: "530196605",
      deductible: null,
      revoked: false,
      revocationDate: null,
      provenance: {
        is501c3: BMF_DC,
        deductible: null,
        revoked: REVOCATION,
        revocationDate: null,
      },
    });
  });
});

describe("GET /v1/search revocation", () => {
  test("reports a revoked org, one the BMF recognized again, and one dropped from the BMF", async () => {
    const revoked = await search("q=lapsed%20community");
    const restored = await search("q=restored%20neighborhood");
    const dropped = await search("q=defunct%20arts");

    expect((await revoked.json()) as OrgSearchResponse).toMatchObject({
      results: [
        {
          ein: "201234567",
          revoked: true,
          revocationDate: "2023-05-15",
          provenance: { revoked: REVOCATION, revocationDate: REVOCATION },
        },
      ],
    });
    expect((await restored.json()) as OrgSearchResponse).toMatchObject({
      results: [
        {
          ein: "461234567",
          revoked: false,
          revocationDate: "2021-05-17",
          provenance: { revoked: BMF_DC, revocationDate: REVOCATION },
        },
      ],
    });
    expect((await dropped.json()) as OrgSearchResponse).toMatchObject({
      results: [
        {
          ein: "311234567",
          is501c3: null,
          revoked: true,
          revocationDate: "2019-05-15",
          provenance: { revoked: REVOCATION, revocationDate: REVOCATION },
        },
      ],
    });
  });

  test("reads revocation from the match's org row and the source-run query, not once per result", async () => {
    const counts = { batches: 0, executes: 0 };
    const counted = await testApi({
      fill: nearMisses,
      dataDbAs: (db) => countingDataDb(db, counts),
    });
    try {
      await counted.app.request("/v1/search?q=youth%20soccer", {
        headers: freshClient(),
      });
      counts.batches = 0;
      counts.executes = 0;

      const response = await counted.app.request("/v1/search?q=red%20cross", {
        headers: freshClient(),
      });
      const body = (await response.json()) as OrgSearchResponse;

      expect(body.results.length).toBeGreaterThan(1);
      expect(body.results[0]?.revoked).toBe(false);
      expect(counts).toStrictEqual({ batches: 1, executes: 0 });
    } finally {
      await counted.dispose();
    }
  });
});

describe("GET /v1/search after a list reinstatement", () => {
  let reinstated: TestApi;

  beforeAll(async () => {
    reinstated = await testApi({
      fill: async (data) => {
        await data.execute(
          "UPDATE orgs SET reinstatement_date = '2024-06-01' WHERE ein = '201234567'",
        );
      },
    });
  });

  afterAll(async () => {
    await reinstated.dispose();
  });

  test("counts a revoked-then-reinstated org as not revoked and keeps the revocation date", async () => {
    const response = await reinstated.app.request(
      "/v1/search?q=lapsed%20community",
      { headers: freshClient() },
    );
    const body = (await response.json()) as OrgSearchResponse;
    expect(body.results[0]).toMatchObject({
      ein: "201234567",
      revoked: false,
      revocationDate: "2023-05-15",
      provenance: { revoked: REVOCATION, revocationDate: REVOCATION },
    });
  });
});

describe("GET /v1/search before the revocation list is imported", () => {
  let early: TestApi;

  beforeAll(async () => {
    early = await testApi({
      fill: async (data) => {
        // the dropped org's name and address cite this run
        await data.execute(
          "UPDATE orgs SET name_run_id = 1, address_run_id = 1 WHERE name_run_id = 3 OR address_run_id = 3",
        );
        await data.execute(
          "DELETE FROM import_runs WHERE source = 'revocation'",
        );
      },
    });
  });

  afterAll(async () => {
    await early.dispose();
  });

  test("answers revoked null and cites no revocation file", async () => {
    const response = await early.app.request("/v1/search?q=red%20cross", {
      headers: freshClient(),
    });
    const body = (await response.json()) as OrgSearchResponse;
    expect(body.results[0]).toMatchObject({
      ein: "530196605",
      revoked: null,
      revocationDate: null,
      provenance: { revoked: null, revocationDate: null },
    });
  });

  test("answers revoked null for an org whose revocation date is still stored", async () => {
    const stored = await early.dataDb.client.execute(
      "SELECT revocation_date FROM orgs WHERE ein = '201234567'",
    );
    expect(stored.rows[0]?.revocation_date).toBe("2023-05-15");

    const response = await early.app.request(
      "/v1/search?q=lapsed%20community",
      { headers: freshClient() },
    );
    const body = (await response.json()) as OrgSearchResponse;
    expect(body.results[0]).toMatchObject({
      ein: "201234567",
      revoked: null,
      revocationDate: null,
      provenance: { revoked: null, revocationDate: null },
    });
  });
});

/** Counts data-database statements a search makes. */
function countingDataDb(
  db: Client,
  counts: { batches: number; executes: number },
): Client {
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch") {
        return (statements: InStatement[], mode?: "read" | "write") => {
          counts.batches += 1;
          return target.batch(statements, mode);
        };
      }
      if (property === "execute") {
        return (statement: InStatement) => {
          counts.executes += 1;
          return target.execute(statement);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Records each `batch` and still runs it on `db`. A missing index has to fail
 * prepare on that client; a stand-in error would not.
 */
function capturingBatch(db: Client, calls: InStatement[][]): Client {
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch") {
        return (statements: InStatement[], mode?: "read" | "write") => {
          calls.push(statements);
          return target.batch(statements, mode);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * United Way Worldwide and its chapters, each in the seeded BMF run and Pub 78
 * and each name three words, so `united way` scores them all the same.
 */
const UNITED_WAYS = [
  {
    ein: "131635294",
    name: "UNITED WAY WORLDWIDE",
    filing: { revenue: 263_000_000, assets: 412_000_000 },
  },
  {
    ein: "010211111",
    name: "UNITED WAY INC",
    filing: { revenue: 2_100_000, assets: 3_400_000 },
  },
  {
    ein: "060222222",
    name: "UNITED WAY ALASKA",
    filing: { revenue: 9_800_000, assets: 1_200_000 },
  },
  // filed returns that report no revenue
  {
    ein: "030444444",
    name: "UNITED WAY VERMONT",
    filing: { revenue: null, assets: 1_000_000 },
  },
  {
    ein: "040555555",
    name: "UNITED WAY IDAHO",
    filing: { revenue: null, assets: 5_000_000 },
  },
  { ein: "010100000", name: "UNITED WAY MAINE", filing: null },
  { ein: "520444444", name: "UNITED WAY OREGON", filing: null },
];

async function unitedWays(data: Client) {
  await data.batch(
    UNITED_WAYS.flatMap(({ ein, name, filing }) => [
      {
        sql: "INSERT INTO orgs (ein, name, name_run_id, subsection, bmf_run_id, in_pub78) VALUES (?1, ?2, 1, '03', 1, 1)",
        args: [ein, name],
      },
      {
        sql: "INSERT INTO orgs_fts (rowid, name) VALUES (CAST(?1 AS INTEGER), ?2)",
        args: [ein, name],
      },
      ...(filing
        ? [
            {
              sql: "INSERT INTO filings (ein, object_id, form_type, tax_period, tax_year, total_revenue, total_assets_eoy, run_id) VALUES (?1, ?1, '990', '2025-06', 2024, ?2, ?3, 5)",
              args: [ein, filing.revenue, filing.assets],
            },
          ]
        : []),
    ]),
    "write",
  );
}

describe("GET /v1/search among names that score the same", () => {
  let tied: TestApi;

  beforeAll(async () => {
    tied = await testApi({ fill: unitedWays });
  });

  afterAll(async () => {
    await tied.dispose();
  });

  async function unitedWayOrder() {
    const response = await tied.app.request("/v1/search?q=united%20way", {
      headers: freshClient(),
    });
    const body = (await response.json()) as OrgSearchResponse;
    return body.results.map((r) => r.ein);
  }

  test("ranks United Way Worldwide, then its chapters, by their latest filing's revenue", async () => {
    expect((await unitedWayOrder()).slice(0, 3)).toEqual([
      "131635294",
      "060222222",
      "010211111",
    ]);
  });

  test("ranks filings that report no revenue by their assets, behind every revenue", async () => {
    expect((await unitedWayOrder()).slice(3, 5)).toEqual([
      "040555555",
      "030444444",
    ]);
  });

  test("keeps orgs with no filing behind the sized ones, in EIN order", async () => {
    expect((await unitedWayOrder()).slice(-2)).toEqual([
      "010100000",
      "520444444",
    ]);
  });

  test("breaks the tie from the covering size index", async () => {
    const calls: InStatement[][] = [];
    const records = await searchNames(
      capturingBatch(tied.dataDb.client, calls),
      ["united", "way"],
      5,
    );
    const sent = calls[0]?.[0];
    if (sent === undefined) {
      throw new Error("searchNames passed nothing to batch");
    }
    const sql = typeof sent === "string" ? sent : sent.sql;
    const args = typeof sent === "string" ? undefined : sent.args;
    const explained = await tied.dataDb.client.execute({
      sql: `EXPLAIN QUERY PLAN ${sql}`,
      ...(args === undefined ? {} : { args }),
    });
    const plan = explained.rows.map((row) => String(row.detail)).join("\n");

    expect(records[0]?.ein).toBe("131635294");
    // Plan of the statement searchNames sent. searchMatchPlan is a second call.
    expect(plan).toContain("USING COVERING INDEX filings_size");
    expect(plan).not.toContain("sqlite_autoindex_filings");
  });
});

describe("GET /v1/search on a database built before the size index", () => {
  let legacy: TestApi;

  beforeAll(async () => {
    legacy = await testApi({ fill: unitedWays });
    await legacy.dataDb.client.execute(`DROP INDEX ${FILING_SIZE_INDEX}`);
  });

  afterAll(async () => {
    await legacy.dispose();
  });

  test("still ranks United Way Worldwide, by the filings primary key", async () => {
    const response = await legacy.app.request(
      "/v1/search?q=united%20way&limit=5",
      { headers: freshClient() },
    );
    const body = (await response.json()) as OrgSearchResponse;
    expect(response.status).toBe(200);
    expect(body.results[0]?.ein).toBe("131635294");
    expect(body.results.map((result) => result.ein).slice(0, 3)).toEqual([
      "131635294",
      "060222222",
      "010211111",
    ]);

    const plan = (
      await searchMatchPlan(legacy.dataDb.client, ["united", "way"], 5)
    ).join("\n");
    expect(plan).toContain("sqlite_autoindex_filings");
    expect(plan).not.toContain(FILING_SIZE_INDEX);
  });
});

describe("GET /v1/search after a legacy database gains the size index", () => {
  let regained: TestApi;

  beforeAll(async () => {
    regained = await testApi({ fill: unitedWays });
  });

  afterAll(async () => {
    await regained.dispose();
  });

  test("returns United Way Worldwide without the index, then searches through it once created", async () => {
    const db = regained.dataDb.client;
    await db.execute(`DROP INDEX ${FILING_SIZE_INDEX}`);
    const without = await searchNames(db, ["united", "way"], 5);
    expect(without[0]?.ein).toBe("131635294");

    await db.execute(
      `CREATE INDEX ${FILING_SIZE_INDEX} ON filings (ein, total_revenue, total_assets_eoy)`,
    );
    const calls: InStatement[][] = [];
    await searchNames(capturingBatch(db, calls), ["united", "way"], 5);
    const sent = calls.at(-1)?.[0];
    const sql = typeof sent === "string" ? sent : sent?.sql;
    expect(sql).toContain(`INDEXED BY ${FILING_SIZE_INDEX}`);
  });
});

/** EINs of 1,001 orgs named alike, in EIN order; only the last two are in Pub 78. */
const ALIKE_EINS = Array.from({ length: 1_001 }, (_, i) =>
  String(800_000_001 + i),
);

/** A filing body large enough that ranking it is the expensive work the cap skips. */
const FAT_MISSION = "M".repeat(64_000);

async function alikeNames(data: Client) {
  // the 1,001st, past the candidate cap
  const pastTheCap = ALIKE_EINS[1_000];
  if (pastTheCap === undefined) {
    throw new Error("the 1,001st alike EIN is missing");
  }
  await data.batch(
    [
      ...ALIKE_EINS.flatMap((ein, i) => [
        {
          sql: "INSERT INTO orgs (ein, name, name_run_id, subsection, bmf_run_id, in_pub78) VALUES (?1, 'QUORUMVILLE FUND', 1, '03', 1, ?2)",
          args: [ein, i >= 999 ? 1 : 0],
        },
        {
          sql: "INSERT INTO orgs_fts (rowid, name) VALUES (CAST(?1 AS INTEGER), 'QUORUMVILLE FUND')",
          args: [ein],
        },
      ]),
      // largest filing, and a mission the tie-break must not have to read:
      // revenue ranking before the cap would return this org first
      {
        sql: "INSERT INTO filings (ein, object_id, form_type, tax_period, tax_year, mission, activity_summary, total_revenue, total_assets_eoy, run_id) VALUES (?1, ?1, '990', '2025-06', 2024, ?2, ?2, 9000000000, 9000000000, 5)",
        args: [pastTheCap, FAT_MISSION],
      },
    ],
    "write",
  );
}

describe("GET /v1/search for a word in more than 1,000 names", () => {
  let broad: TestApi;

  beforeAll(async () => {
    broad = await testApi({ fill: alikeNames });
  });

  afterAll(async () => {
    await broad.dispose();
  });

  test("ranks only the first 1,000 matches in EIN order: the 1,000th leads as a Pub 78 org, and the 1,001st is never returned even though its filing is the largest", async () => {
    const response = await broad.app.request("/v1/search?q=quorumville", {
      headers: freshClient(),
    });
    const eins = ((await response.json()) as OrgSearchResponse).results.map(
      (r) => r.ein,
    );

    expect(eins[0]).toBe(ALIKE_EINS[999]);
    expect(eins).not.toContain(ALIKE_EINS[1_000]);
  });
});
