/**
 * The full-text index over org names. Contentless: it stores no copy of the
 * names, only the index, keyed by the EIN as an integer rowid.
 */
export function searchIndexDdl(): string {
  return `-- Org names for search; rowid is the EIN as an integer. Filled whole once
-- per build by finishDataDatabase; never written row by row.
CREATE VIRTUAL TABLE orgs_fts USING fts5 (
  name,
  content = '',
  tokenize = 'unicode61 remove_diacritics 2'
);
`;
}
