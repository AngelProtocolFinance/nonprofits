import type { Result } from "./result.ts";
import { is501c3, isDeductible } from "./rules.ts";

/** One name match, as an `OrgSearcher` returns it. */
export interface OrgSearchRecord {
  ein: string;
  name: string;
  city: string | null;
  state: string | null;
  /** null when the org is not in the current BMF. */
  bmf: { subsection: string } | null;
  /** null until Pub 78 is imported. */
  pub78: { listed: boolean } | null;
}

/** The search seam: the Worker satisfies it with a D1 full-text index. */
export interface OrgSearcher {
  /** Best matches for `query` first, at most `limit`. */
  search(query: string, limit: number): Promise<OrgSearchRecord[]>;
}

export interface OrgSearchMatch {
  ein: string;
  name: string;
  city: string | null;
  state: string | null;
  is501c3: boolean | null;
  deductible: boolean | null;
}

/** `GET /v1/search` and the MCP search tool both answer with this shape. */
export interface OrgSearchResponse {
  /** The query as searched, surrounding spaces dropped. */
  query: string;
  /** The page size applied. */
  limit: number;
  /** Best match first. */
  results: OrgSearchMatch[];
}

export type OrgSearchError =
  | { code: "invalid_query"; message: string }
  | { code: "invalid_limit"; message: string };

export type OrgSearchResult = Result<OrgSearchResponse, OrgSearchError>;

/** Page sizes: a request above `max` is capped, not refused. */
const SEARCH_LIMIT = { default: 10, max: 50 } as const;

export async function searchOrgs(
  input: { query: string; limit?: number | undefined },
  searcher: OrgSearcher,
): Promise<OrgSearchResult> {
  const query = input.query.trim();
  if (query.length < 2) {
    return {
      ok: false,
      error: {
        code: "invalid_query",
        message:
          'Search query must be at least 2 characters, not counting surrounding spaces, e.g. "red cross".',
      },
    };
  }
  const requested = input.limit ?? SEARCH_LIMIT.default;
  if (!Number.isInteger(requested) || requested < 1) {
    return {
      ok: false,
      error: {
        code: "invalid_limit",
        message: `limit must be a whole number from 1; above ${SEARCH_LIMIT.max} is capped at ${SEARCH_LIMIT.max}.`,
      },
    };
  }
  const limit = Math.min(requested, SEARCH_LIMIT.max);
  const records = await searcher.search(query, limit);
  return {
    ok: true,
    value: {
      query,
      limit,
      results: records.map((r) => ({
        ein: r.ein,
        name: r.name,
        city: r.city,
        state: r.state,
        is501c3: is501c3(r.bmf),
        deductible: isDeductible(r.pub78),
      })),
    },
  };
}
