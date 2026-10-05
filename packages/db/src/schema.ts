/** IRS bulk files an import can fetch; `import_runs.source` holds one. */
const IMPORT_SOURCES = [
  "bmf",
  "pub78",
  "revocation",
  "epostcard",
  "efile_index",
  "efile_xml",
] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/**
 * Every table in a data database. Auth and usage tables live in the app
 * database and never belong here.
 */
export const DATA_TABLES = [
  "orgs_fts",
  "programs",
  "filings",
  "orgs",
  "import_runs",
  "data_meta",
] as const;
export type DataTable = (typeof DATA_TABLES)[number];

export const COLUMNS = {
  import_runs: [
    "id",
    "source",
    "file_url",
    "released_at",
    "fetched_at",
    "row_count",
  ],
  orgs: [
    "ein",
    "name",
    "name_run_id",
    "street",
    "city",
    "state",
    "zip",
    "address_run_id",
    "bmf_run_id",
    "subsection",
    "ntee",
    "ruling_date",
    "deductibility_code",
    "filing_requirement_code",
    "in_pub78",
    "revocation_date",
    "reinstatement_date",
    "files_990n",
    "epostcard_website",
  ],
  filings: [
    "ein",
    "object_id",
    "return_id",
    "form_type",
    "tax_period",
    "tax_year",
    "mission",
    "activity_summary",
    "website",
    "total_revenue",
    "total_expenses",
    "total_assets_eoy",
    "run_id",
    "mission_on_schedule_o",
  ],
  programs: [
    "ein",
    "object_id",
    "rank",
    "description",
    "expense",
    "grants",
    "revenue",
  ],
} as const satisfies Record<
  Exclude<DataTable, "orgs_fts" | "data_meta">,
  readonly string[]
>;

/**
 * CHECK conditions for the text dates the data databases hold; they compare
 * as text, so each holds one shape: the one SQLite's own date functions write
 * for it, which also rules out a day or month the calendar lacks, as no GLOB
 * pattern can. A null passes (`IS`).
 */
export function dateCheck(
  column: string,
  shape: "yearMonth" | "date" | "isoSeconds",
): string {
  switch (shape) {
    case "yearMonth":
      return `strftime('%Y-%m', ${column} || '-01') IS ${column}`;
    case "date":
      return `date(${column}) IS ${column}`;
    case "isoSeconds":
      return `strftime('%Y-%m-%dT%H:%M:%SZ', ${column}) IS ${column}`;
  }
}

/** CREATE statements for the loaded data tables; part of what `createDataDatabase` builds. */
export function dataTablesDdl(): string {
  const sources = IMPORT_SOURCES.map((s) => `'${s}'`).join(", ");
  return `-- One row per IRS bulk file fetched, written when its import commits.
-- The latest run per source is that file's current state.
CREATE TABLE import_runs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN (${sources})),
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
  ruling_date TEXT CHECK (${dateCheck("ruling_date", "yearMonth")}),
  deductibility_code TEXT,
  filing_requirement_code TEXT,
  -- list membership as of the latest pub78 / revocation / epostcard run
  in_pub78 INTEGER NOT NULL DEFAULT 0 CHECK (in_pub78 IN (0, 1)),
  revocation_date TEXT CHECK (${dateCheck("revocation_date", "date")}),
  reinstatement_date TEXT CHECK (${dateCheck("reinstatement_date", "date")}),
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
  -- 1 when the mission field only points to Schedule O; mission is then null
  mission_on_schedule_o INTEGER NOT NULL DEFAULT 0 CHECK (mission_on_schedule_o IN (0, 1)),
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
`;
}
