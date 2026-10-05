/**
 * The full-text index over org names. Contentless: it stores no copy of the
 * names, only the index, keyed by the EIN as an integer rowid.
 */
export function searchIndexDdl(): string {
  return `-- Org names for search; rowid is the EIN as an integer. Filled whole once
-- per build: by rebuildSearchIndexSql in a D1 slot, after a refresh or a local
-- load run, or by finishDataDatabase in a Turso database; never written row by
-- row.
CREATE VIRTUAL TABLE orgs_fts USING fts5 (
  name,
  content = '',
  tokenize = 'unicode61 remove_diacritics 2'
);
`;
}

/** SQL true only while the generation is still being built; FTS5 takes no trigger to seal it. */
const BUILDING = "(SELECT state FROM data_meta WHERE id = 1) = 'building'";

/**
 * Empties `orgs_fts` and indexes every named row of `orgs`, one statement per
 * two-digit EIN prefix: D1 stops a single query at 30 s. On 3.03M named orgs
 * the slowest chunk (prefix 23, 144k names) took 0.44 s locally. Every
 * statement writes only while `data_meta` says building, so a sealed index is
 * never emptied.
 *
 * The first line names `buildId`: a remote `--file` import is keyed by the
 * file's md5, and a byte-identical file from an earlier build can be taken as
 * already ingested.
 */
export function rebuildSearchIndexSql(buildId: string): string {
  if (/[\r\n]/.test(buildId)) {
    throw new Error("a build id is one line: it heads the file as a comment");
  }
  const chunks = Array.from({ length: 100 }, (_, i) => {
    const prefix = String(i).padStart(2, "0");
    return `INSERT INTO orgs_fts (rowid, name)
SELECT CAST(ein AS INTEGER), name FROM orgs
WHERE ein BETWEEN '${prefix}0000000' AND '${prefix}9999999' AND name IS NOT NULL AND ${BUILDING};`;
  });
  return [
    `-- build ${buildId}`,
    `INSERT INTO orgs_fts (orgs_fts) SELECT 'delete-all' WHERE ${BUILDING};`,
    ...chunks,
  ]
    .join("\n")
    .concat("\n");
}
