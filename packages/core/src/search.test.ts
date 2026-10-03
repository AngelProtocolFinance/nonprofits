import { describe, expect, test } from "vitest";
import {
  type OrgSearcher,
  type OrgSearchRecord,
  searchOrgs,
} from "./search.ts";

function searcherOf(
  ...records: OrgSearchRecord[]
): OrgSearcher & { calls: { words: string[]; limit: number }[] } {
  const calls: { words: string[]; limit: number }[] = [];
  return {
    calls,
    async search(words, limit) {
      calls.push({ words, limit });
      return records.slice(0, limit);
    },
  };
}

describe("searchOrgs", () => {
  test.each(["", " ", "a", "  b  "])(
    "refuses %j as too short without searching",
    async (query) => {
      const searcher = searcherOf();
      expect(await searchOrgs({ query }, searcher)).toStrictEqual({
        ok: false,
        error: {
          code: "invalid_query",
          message:
            'Search query must be at least 2 characters, not counting surrounding spaces, e.g. "red cross".',
        },
      });
      expect(searcher.calls).toEqual([]);
    },
  );

  test("answers the matches with 501(c)(3) and deductibility from the shared rules", async () => {
    const searcher = searcherOf(
      {
        ein: "530196605",
        name: "AMERICAN NATIONAL RED CROSS",
        city: "WASHINGTON",
        state: "DC",
        bmf: { subsection: "03" },
        pub78: { listed: true },
      },
      {
        ein: "262622865",
        name: "RED CROSS OF CONSTANTINE",
        city: "JOPLIN",
        state: "MO",
        bmf: { subsection: "08" },
        pub78: { listed: false },
      },
      {
        ein: "311234567",
        name: "RED CROSS ARTS COUNCIL",
        city: null,
        state: null,
        bmf: null,
        pub78: null,
      },
    );
    expect(await searchOrgs({ query: "  red cross " }, searcher)).toStrictEqual(
      {
        ok: true,
        value: {
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
              ein: "262622865",
              name: "RED CROSS OF CONSTANTINE",
              city: "JOPLIN",
              state: "MO",
              is501c3: false,
              deductible: false,
            },
            {
              ein: "311234567",
              name: "RED CROSS ARTS COUNCIL",
              city: null,
              state: null,
              is501c3: null,
              deductible: null,
            },
          ],
        },
      },
    );
    expect(searcher.calls).toEqual([{ words: ["red", "cross"], limit: 10 }]);
  });

  test.each([
    [1, 1],
    [50, 50],
    [51, 50],
    [10_000, 50],
  ])("applies limit %j as %j and echoes it", async (requested, applied) => {
    const searcher = searcherOf();
    const result = await searchOrgs(
      { query: "red cross", limit: requested },
      searcher,
    );
    expect(result).toMatchObject({ ok: true, value: { limit: applied } });
    expect(searcher.calls).toEqual([
      { words: ["red", "cross"], limit: applied },
    ]);
  });

  test.each([0, -1, 2.5, Number.NaN])(
    "refuses limit %j without searching",
    async (limit) => {
      const searcher = searcherOf();
      expect(
        await searchOrgs({ query: "red cross", limit }, searcher),
      ).toStrictEqual({
        ok: false,
        error: {
          code: "invalid_limit",
          message:
            "limit must be a whole number from 1; above 50 is capped at 50.",
        },
      });
      expect(searcher.calls).toEqual([]);
    },
  );

  test("searches each word once, whatever its case, and echoes the words searched", async () => {
    const searcher = searcherOf();
    const result = await searchOrgs(
      { query: `${"inc ".repeat(40)}Red INC red cross` },
      searcher,
    );
    expect(result).toMatchObject({
      ok: true,
      value: { query: "inc Red cross" },
    });
    expect(searcher.calls).toEqual([
      { words: ["inc", "Red", "cross"], limit: 10 },
    ]);
  });

  test("searches the first 8 words of a longer query", async () => {
    const searcher = searcherOf();
    const result = await searchOrgs(
      { query: "one two three four five six seven eight nine ten" },
      searcher,
    );
    const words = [
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
    ];
    expect(result).toMatchObject({
      ok: true,
      value: { query: words.join(" ") },
    });
    expect(searcher.calls).toEqual([{ words, limit: 10 }]);
  });

  test("reads punctuation as a word break and drops apostrophes", async () => {
    const searcher = searcherOf();
    await searchOrgs({ query: '"st. jude" (children’s) AND-OR*' }, searcher);
    expect(searcher.calls).toEqual([
      { words: ["st", "jude", "childrens", "AND", "OR"], limit: 10 },
    ]);
  });

  test("composes a decomposed letter before splitting words", async () => {
    const searcher = searcherOf();
    await searchOrgs({ query: "Mu\u0308ller foundation" }, searcher);
    expect(searcher.calls).toEqual([
      { words: ["M\u00fcller", "foundation"], limit: 10 },
    ]);
  });

  test("refuses a query over 200 characters without searching", async () => {
    const searcher = searcherOf();
    expect(
      await searchOrgs({ query: "a".repeat(201) }, searcher),
    ).toStrictEqual({
      ok: false,
      error: {
        code: "invalid_query",
        message:
          "Search query must be at most 200 characters: send a few distinctive words of the name.",
      },
    });
    expect(searcher.calls).toEqual([]);
    expect(
      await searchOrgs({ query: "a".repeat(200) }, searcher),
    ).toMatchObject({
      ok: true,
    });
  });

  test.each(["**", '"" ""', "-- !"])(
    "refuses %j, which holds no word, without searching",
    async (query) => {
      const searcher = searcherOf();
      expect(await searchOrgs({ query }, searcher)).toStrictEqual({
        ok: false,
        error: {
          code: "invalid_query",
          message:
            'Search query must hold a word of letters or digits, e.g. "red cross".',
        },
      });
      expect(searcher.calls).toEqual([]);
    },
  );
});
