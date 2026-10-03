-- One row per IRS bulk file fetched, written when its import commits.
-- The latest run per source is that file's current state.
CREATE TABLE import_runs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('bmf', 'pub78', 'revocation', 'epostcard', 'efile_index', 'efile_xml')),
  file_url TEXT NOT NULL,
  -- the file's Last-Modified, ISO-8601
  released_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count >= 0)
) STRICT;

CREATE INDEX import_runs_source ON import_runs (source, id);

CREATE TABLE orgs (
  ein TEXT PRIMARY KEY CHECK (length(ein) = 9 AND ein NOT GLOB '*[^0-9]*'),
  name TEXT,
  name_run_id INTEGER REFERENCES import_runs (id),
  street TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  address_run_id INTEGER REFERENCES import_runs (id),
  -- BMF facts; all null when the org is not in the current BMF
  bmf_run_id INTEGER REFERENCES import_runs (id),
  subsection TEXT,
  ntee TEXT,
  -- BMF RULING, as YYYY-MM
  ruling_date TEXT,
  deductibility_code TEXT,
  filing_requirement_code TEXT,
  -- list membership as of the latest pub78 / revocation / epostcard run
  in_pub78 INTEGER NOT NULL DEFAULT 0 CHECK (in_pub78 IN (0, 1)),
  revocation_date TEXT,
  reinstatement_date TEXT,
  files_990n INTEGER NOT NULL DEFAULT 0 CHECK (files_990n IN (0, 1)),
  epostcard_website TEXT,
  CHECK ((name IS NULL) = (name_run_id IS NULL)),
  CHECK (
    address_run_id IS NOT NULL
    OR (street IS NULL AND city IS NULL AND state IS NULL AND zip IS NULL)
  ),
  CHECK ((subsection IS NULL) = (bmf_run_id IS NULL)),
  CHECK (reinstatement_date IS NULL OR revocation_date IS NOT NULL),
  CHECK (epostcard_website IS NULL OR files_990n = 1)
) STRICT;

-- The latest e-filed return per EIN.
CREATE TABLE filings (
  ein TEXT PRIMARY KEY REFERENCES orgs (ein) ON DELETE CASCADE,
  object_id TEXT NOT NULL,
  return_id TEXT,
  form_type TEXT NOT NULL CHECK (form_type IN ('990', '990-EZ', '990-PF')),
  -- YYYY-MM
  tax_period TEXT NOT NULL,
  tax_year INTEGER NOT NULL,
  mission TEXT,
  activity_summary TEXT,
  website TEXT,
  total_revenue INTEGER,
  total_expenses INTEGER,
  total_assets_eoy INTEGER,
  -- the efile_xml run whose zip held this return
  run_id INTEGER NOT NULL REFERENCES import_runs (id),
  UNIQUE (ein, object_id)
) STRICT;

-- Replacing a filing's object_id fails while its old programs remain.
CREATE TABLE programs (
  ein TEXT NOT NULL,
  object_id TEXT NOT NULL,
  -- 1 = largest program expense
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 3),
  description TEXT,
  expense INTEGER,
  grants INTEGER,
  revenue INTEGER,
  PRIMARY KEY (ein, object_id, rank),
  FOREIGN KEY (ein, object_id)
    REFERENCES filings (ein, object_id) ON DELETE CASCADE
) STRICT;
