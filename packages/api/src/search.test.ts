import type { Client } from "@libsql/client";
import type { OrgSearchResponse } from "@nonprofits/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { freshClient, type TestApi, testApi } from "./test-support.ts";

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

/** The near misses, beside the fixture's Red Cross, in the orgs and the search index. */
async function nearMisses(data: Client) {
  await data.batch(
    NEAR_MISSES.flatMap(({ ein, name, subsection }) => [
      {
        sql: "INSERT INTO orgs (ein, name, name_run_id, subsection, bmf_run_id) VALUES (?1, ?2, 1, ?3, iif(?3 IS NULL, NULL, 1))",
        args: [ein, name, subsection],
      },
      {
        sql: "INSERT INTO orgs_fts (rowid, name) VALUES (CAST(?1 AS INTEGER), ?2)",
        args: [ein, name],
      },
    ]),
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
  test("ranks the Red Cross above names that only share its words", async () => {
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
        },
        {
          ein: "581771391",
          name: "RED CROSS CIVITANS",
          city: null,
          state: null,
          is501c3: false,
          deductible: false,
        },
        {
          ein: "362276983",
          name: "AMERICAN RED CROSS",
          city: null,
          state: null,
          is501c3: null,
          deductible: false,
        },
        {
          ein: "841189480",
          name: "RED MOUNTAIN CROSS PRESERVATION ASSOCIATION",
          city: null,
          state: null,
          is501c3: null,
          deductible: false,
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
