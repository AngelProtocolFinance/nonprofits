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
  /** Names holding every one of `words`, best first, at most `limit`. */
  search(words: string[], limit: number): Promise<OrgSearchRecord[]>;
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
  /** The words searched, space-separated: each once as first spelled, at most 8, punctuation dropped. */
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

const QUERY_CHARS = { min: 2, max: 200 } as const;

/** Each word is one more posting list for FTS to intersect. */
const MAX_WORDS = 8;

function invalidQuery(message: string): OrgSearchResult {
  return { ok: false, error: { code: "invalid_query", message } };
}

/**
 * Runs of letters and digits, composed first so a decomposed `ü` stays one
 * letter; apostrophes are dropped since BMF names spell `CHILDRENS`. Each word
 * is kept once, whatever its case: 200 × `inc` took 8.4 s to rank on the real
 * index.
 */
function wordsOf(query: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const [word] of query
    .normalize("NFC")
    .replace(/['’]/g, "")
    .matchAll(/[\p{L}\p{N}]+/gu)) {
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
    if (words.length === MAX_WORDS) break;
  }
  return words;
}

export async function searchOrgs(
  input: { query: string; limit?: number | undefined },
  searcher: OrgSearcher,
): Promise<OrgSearchResult> {
  const trimmed = input.query.trim();
  if (trimmed.length < QUERY_CHARS.min) {
    return invalidQuery(
      `Search query must be at least ${QUERY_CHARS.min} characters, not counting surrounding spaces, e.g. "red cross".`,
    );
  }
  if (trimmed.length > QUERY_CHARS.max) {
    return invalidQuery(
      `Search query must be at most ${QUERY_CHARS.max} characters: send a few distinctive words of the name.`,
    );
  }
  const words = wordsOf(trimmed);
  if (words.length === 0) {
    return invalidQuery(
      'Search query must hold a word of letters or digits, e.g. "red cross".',
    );
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
  const records = await searcher.search(words, limit);
  return {
    ok: true,
    value: {
      query: words.join(" "),
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
