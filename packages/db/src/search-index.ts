/**
 * The full-text index over org names, named `orgs_fts` + `suffix` beside
 * `orgs` + `suffix`. Contentless: it stores no copy of the names, only the
 * index, keyed by the EIN as an integer rowid. FTS5 renames its shadow tables
 * with it, so a suffixed index swaps in like the tables it was built from.
 */
export function searchIndexDdl(suffix: string): string {
  return `-- Org names for search; rowid is the EIN as an integer. Rebuilt after each
-- load (rebuildSearchIndexSql), never written row by row.
CREATE VIRTUAL TABLE orgs_fts${suffix} USING fts5 (
  name,
  content = '',
  tokenize = 'unicode61 remove_diacritics 2'
);
`;
}

/**
 * Empties `orgs_fts` + `suffix` and indexes every named row of `orgs` +
 * `suffix`, one statement per two-digit EIN prefix: D1 stops a single query
 * at 30 s, and the largest prefix holds under 100k orgs.
 */
export function rebuildSearchIndexSql(suffix: string): string {
  const fts = `orgs_fts${suffix}`;
  const chunks = Array.from({ length: 100 }, (_, i) => {
    const prefix = String(i).padStart(2, "0");
    return `INSERT INTO ${fts} (rowid, name)
SELECT CAST(ein AS INTEGER), name FROM orgs${suffix}
WHERE ein BETWEEN '${prefix}0000000' AND '${prefix}9999999' AND name IS NOT NULL;`;
  });
  return [`INSERT INTO ${fts} (${fts}) VALUES ('delete-all');`, ...chunks]
    .join("\n")
    .concat("\n");
}
