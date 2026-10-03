import type { OrgSearcher, OrgSearchRecord } from "@nonprofits/core";

interface MatchRow {
  ein: string;
  name: string;
  city: string | null;
  state: string | null;
  subsection: string | null;
  in_pub78: 0 | 1;
}

/**
 * Ranking reads each candidate's indexed length and org row, so a word in
 * 600k names (`inc`) would read them all: only this many matches, in EIN
 * order, are ranked.
 */
const MAX_CANDIDATES = 10_000;

/**
 * Orgs in Pub 78 first, then the rest of the current BMF, then orgs the BMF
 * no longer lists; bm25 orders each tier and EIN breaks ties. Every match
 * holds every word, so the tiers outweigh bm25's preference for short names:
 * a dropped chapter named AMERICAN RED CROSS outscores the national org.
 */
const SEARCH_SQL = `
SELECT o.ein, o.name, o.city, o.state, o.subsection, o.in_pub78
FROM (
  SELECT rowid, rank AS score FROM orgs_fts WHERE orgs_fts MATCH ?1 LIMIT ${MAX_CANDIDATES}
) m
JOIN orgs o ON o.ein = printf('%09d', m.rowid) AND o.name IS NOT NULL
ORDER BY o.in_pub78 DESC, o.bmf_run_id IS NULL, m.score, m.rowid
LIMIT ?2`;

const PUB78_IMPORTED_SQL = `
SELECT EXISTS (SELECT 1 FROM import_runs WHERE source = 'pub78') AS imported`;

/**
 * Each word of `query` as a quoted FTS5 string, so no input reads as FTS5
 * syntax; null when it has no word. Apostrophes are dropped first, since BMF
 * names spell `CHILDRENS`.
 */
function matchExpression(query: string): string | null {
  const words = query.replace(/['’]/g, "").match(/[\p{L}\p{N}]+/gu);
  return words === null ? null : words.map((w) => `"${w}"`).join(" ");
}

/** Searches org names in one D1 round trip, reporting D1's `meta.rows_read`. */
export class D1OrgSearcher implements OrgSearcher {
  constructor(
    private readonly db: D1Database,
    private readonly onRowsRead: (rows: number) => void,
  ) {}

  async search(query: string, limit: number): Promise<OrgSearchRecord[]> {
    const match = matchExpression(query);
    if (match === null) return [];
    const results = (await this.db.batch([
      this.db.prepare(SEARCH_SQL).bind(match, limit),
      this.db.prepare(PUB78_IMPORTED_SQL),
    ])) as [D1Result<MatchRow>, D1Result<{ imported: 0 | 1 }>];
    this.onRowsRead(results.reduce((sum, r) => sum + r.meta.rows_read, 0));

    const [matches, pub78] = results;
    const pub78Imported = pub78.results[0]?.imported === 1;
    return matches.results.map((row) => ({
      ein: row.ein,
      name: row.name,
      city: row.city,
      state: row.state,
      bmf: row.subsection === null ? null : { subsection: row.subsection },
      pub78: pub78Imported ? { listed: row.in_pub78 === 1 } : null,
    }));
  }
}
