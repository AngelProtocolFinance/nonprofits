import { FILING_SIZE_INDEX } from "./schema.ts";

/**
 * Ranking reads each candidate's FTS entry, org row and filing size, so a
 * word in 912k names (`inc`) would read them all: only this many matches, in
 * EIN order, are ranked, and a broad word's best match can fall past them.
 * The service-wide daily ceilings in quota.ts are sized on it.
 */
const MAX_CANDIDATES = 1_000;

/**
 * Of the first MAX_CANDIDATES matches in EIN order: orgs in Pub 78 first,
 * then the rest of the current BMF, then orgs the BMF no longer lists; bm25
 * orders each tier. Every match holds every word, so
 * the tiers outweigh bm25's preference for short names: a dropped chapter
 * named AMERICAN RED CROSS would otherwise outscore the national org. At an
 * equal score the larger org leads, so UNITED WAY WORLDWIDE tops its chapters:
 * its latest filing's revenue, then its assets, a missing figure or filing
 * last; EIN breaks the ties left. `united way` ties across the whole candidate
 * window, and revenue sits after mission and activity_summary, so the primary
 * key would read both texts per candidate and time out on Turso. INDEXED BY
 * the covering size index reads only the figures; without it the unanalyzed
 * planner picks the primary key even when the index exists. A database built
 * before the index still answers through the primary key.
 */
export function searchSql(indexed: boolean): string {
  const filings = indexed
    ? `LEFT JOIN filings f INDEXED BY ${FILING_SIZE_INDEX} ON f.ein = o.ein`
    : "LEFT JOIN filings f ON f.ein = o.ein";
  return `
SELECT o.ein, o.name, o.city, o.state, o.subsection, o.ruling_date, o.bmf_run_id,
  o.in_pub78, o.revocation_date, o.reinstatement_date
FROM (
  SELECT rowid, rank AS score FROM orgs_fts WHERE orgs_fts MATCH ?1 LIMIT ${MAX_CANDIDATES}
) m
JOIN orgs o ON o.ein = printf('%09d', m.rowid) AND o.name IS NOT NULL
${filings}
ORDER BY o.in_pub78 DESC, o.bmf_run_id IS NULL, m.score,
  f.total_revenue DESC NULLS LAST, f.total_assets_eoy DESC NULLS LAST, m.rowid
LIMIT ?2`;
}

/** Each word as a quoted FTS5 string, so no word reads as FTS5 syntax. */
export function matchExpression(words: string[]): string {
  return words.map((w) => `"${w.replaceAll('"', '""')}"`).join(" ");
}
