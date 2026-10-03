-- Org names for search; rowid is the EIN as an integer. Rebuilt after each
-- load (rebuildSearchIndexSql), never written row by row.
CREATE VIRTUAL TABLE orgs_fts USING fts5 (
  name,
  content = '',
  tokenize = 'unicode61 remove_diacritics 2'
);
