import { describe, expect, test } from "vitest";
import {
  type OrgSearcher,
  type OrgSearchRecord,
  searchOrgs,
} from "./search.ts";

function searcherOf(
  ...records: OrgSearchRecord[]
): OrgSearcher & { calls: { query: string; limit: number }[] } {
  const calls: { query: string; limit: number }[] = [];
  return {
    calls,
    async search(query, limit) {
      calls.push({ query, limit });
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
    expect(searcher.calls).toEqual([{ query: "red cross", limit: 10 }]);
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
    expect(searcher.calls).toEqual([{ query: "red cross", limit: applied }]);
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
});
