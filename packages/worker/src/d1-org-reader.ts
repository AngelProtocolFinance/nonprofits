import type {
  FilingRecord,
  FormType,
  OrgReader,
  OrgRecord,
  SourceFile,
} from "@irs-lookup/core";

interface OrgRow {
  ein: string;
  name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  subsection: string;
  deductible: 0 | 1 | null;
  revoked: 0 | 1 | null;
  revocation_date: string | null;
  files_990n: 0 | 1;
  epostcard_website: string | null;
  bmf_file: string;
  bmf_released_at: string;
  bmf_fetched_at: string;
  pub78_file: string | null;
  pub78_released_at: string | null;
  pub78_fetched_at: string | null;
  revocation_file: string | null;
  revocation_released_at: string | null;
  revocation_fetched_at: string | null;
  epostcard_file: string | null;
  epostcard_released_at: string | null;
  epostcard_fetched_at: string | null;
}

interface FilingRow {
  object_id: string;
  form_type: FormType;
  tax_year: number;
  mission: string | null;
  activity_summary: string | null;
  website: string | null;
  total_revenue: number | null;
  total_expenses: number | null;
  total_assets_eoy: number | null;
  file: string;
  released_at: string;
  fetched_at: string;
}

interface ProgramRow {
  description: string | null;
  expense: number | null;
  grants: number | null;
  revenue: number | null;
}

const ORG_SQL = `
SELECT o.ein, o.name, o.street, o.city, o.state, o.zip, o.subsection,
  o.deductible, o.revoked, o.revocation_date, o.files_990n, o.epostcard_website,
  b.file_url AS bmf_file, b.released_at AS bmf_released_at, b.fetched_at AS bmf_fetched_at,
  p.file_url AS pub78_file, p.released_at AS pub78_released_at, p.fetched_at AS pub78_fetched_at,
  r.file_url AS revocation_file, r.released_at AS revocation_released_at, r.fetched_at AS revocation_fetched_at,
  e.file_url AS epostcard_file, e.released_at AS epostcard_released_at, e.fetched_at AS epostcard_fetched_at
FROM orgs o
JOIN import_runs b ON b.id = o.bmf_run_id
LEFT JOIN import_runs p ON p.id = o.pub78_run_id
LEFT JOIN import_runs r ON r.id = o.revocation_run_id
LEFT JOIN import_runs e ON e.id = o.epostcard_run_id
WHERE o.ein = ?1`;

const FILING_SQL = `
SELECT f.object_id, f.form_type, f.tax_year, f.mission, f.activity_summary, f.website,
  f.total_revenue, f.total_expenses, f.total_assets_eoy,
  i.file_url AS file, i.released_at, i.fetched_at
FROM filings f
JOIN import_runs i ON i.id = f.run_id
WHERE f.ein = ?1`;

const PROGRAMS_SQL = `
SELECT description, expense, grants, revenue
FROM programs
WHERE ein = ?1
ORDER BY rank`;

/** Reads one EIN in a single D1 round trip; `rowsRead` totals D1's `meta.rows_read`. */
export class D1OrgReader implements OrgReader {
  rowsRead = 0;

  constructor(private readonly db: D1Database) {}

  async read(ein: string): Promise<OrgRecord | null> {
    const [orgs, filings, programs] = (await this.db.batch([
      this.db.prepare(ORG_SQL).bind(ein),
      this.db.prepare(FILING_SQL).bind(ein),
      this.db.prepare(PROGRAMS_SQL).bind(ein),
    ])) as [D1Result<OrgRow>, D1Result<FilingRow>, D1Result<ProgramRow>];
    this.rowsRead +=
      orgs.meta.rows_read + filings.meta.rows_read + programs.meta.rows_read;

    const org = orgs.results[0];
    if (org === undefined) return null;
    const filing = filings.results[0];
    return toRecord(org, filing ? toFiling(filing, programs.results) : null);
  }
}

function source(
  file: string | null,
  releasedAt: string | null,
  fetchedAt: string | null,
): SourceFile | null {
  return file === null || releasedAt === null || fetchedAt === null
    ? null
    : { file, releasedAt, fetchedAt };
}

function toRecord(row: OrgRow, filing: FilingRecord | null): OrgRecord {
  const pub78 = source(
    row.pub78_file,
    row.pub78_released_at,
    row.pub78_fetched_at,
  );
  const revocation = source(
    row.revocation_file,
    row.revocation_released_at,
    row.revocation_fetched_at,
  );
  const epostcard = source(
    row.epostcard_file,
    row.epostcard_released_at,
    row.epostcard_fetched_at,
  );
  return {
    ein: row.ein,
    name: row.name,
    address: {
      street: row.street,
      city: row.city,
      state: row.state,
      zip: row.zip,
    },
    subsection: row.subsection,
    bmf: {
      file: row.bmf_file,
      releasedAt: row.bmf_released_at,
      fetchedAt: row.bmf_fetched_at,
    },
    pub78:
      pub78 && row.deductible !== null
        ? { deductible: row.deductible === 1, source: pub78 }
        : null,
    revocation:
      revocation && row.revoked !== null
        ? {
            revoked: row.revoked === 1,
            date: row.revocation_date,
            source: revocation,
          }
        : null,
    epostcard: epostcard && {
      website: row.epostcard_website,
      source: epostcard,
    },
    filing,
  };
}

function toFiling(row: FilingRow, programs: ProgramRow[]): FilingRecord {
  return {
    objectId: row.object_id,
    formType: row.form_type,
    taxYear: row.tax_year,
    mission: row.mission,
    activitySummary: row.activity_summary,
    website: row.website,
    totalRevenue: row.total_revenue,
    totalExpenses: row.total_expenses,
    totalAssetsEoy: row.total_assets_eoy,
    programs,
    source: {
      file: row.file,
      releasedAt: row.released_at,
      fetchedAt: row.fetched_at,
    },
  };
}
