-- One row per IRS bulk file fetched; every fact below cites one.
CREATE TABLE import_runs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (
    source IN ('bmf', 'pub78', 'revocation', 'epostcard', 'efile_index')
  ),
  file_url TEXT NOT NULL,
  -- the file's Last-Modified, ISO-8601
  released_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count >= 0)
) STRICT;

CREATE TABLE orgs (
  ein TEXT PRIMARY KEY CHECK (length(ein) = 9 AND ein NOT GLOB '*[^0-9]*'),
  name TEXT NOT NULL,
  street TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  subsection TEXT NOT NULL,
  ntee TEXT,
  -- BMF RULING, as YYYY-MM
  ruling_date TEXT,
  deductibility_code TEXT,
  filing_requirement_code TEXT,
  bmf_run_id INTEGER NOT NULL REFERENCES import_runs (id),
  -- Pub 78 listing; null until a Pub 78 import has run
  deductible INTEGER CHECK (deductible IN (0, 1)),
  pub78_run_id INTEGER REFERENCES import_runs (id),
  -- auto-revocation list; null until a revocation import has run
  revoked INTEGER CHECK (revoked IN (0, 1)),
  revocation_date TEXT,
  revocation_run_id INTEGER REFERENCES import_runs (id),
  files_990n INTEGER NOT NULL DEFAULT 0 CHECK (files_990n IN (0, 1)),
  epostcard_website TEXT,
  epostcard_run_id INTEGER REFERENCES import_runs (id),
  CHECK ((deductible IS NULL) = (pub78_run_id IS NULL)),
  CHECK ((revoked IS NULL) = (revocation_run_id IS NULL)),
  CHECK (revocation_date IS NULL OR revoked = 1),
  CHECK (files_990n = (epostcard_run_id IS NOT NULL)),
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
  run_id INTEGER NOT NULL REFERENCES import_runs (id)
) STRICT;

CREATE TABLE programs (
  ein TEXT NOT NULL REFERENCES filings (ein) ON DELETE CASCADE,
  -- 1 = largest program expense
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 3),
  description TEXT,
  expense INTEGER,
  grants INTEGER,
  revenue INTEGER,
  PRIMARY KEY (ein, rank)
) STRICT;
