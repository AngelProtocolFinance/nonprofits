import type { Client } from "@libsql/client";
import type {
  FilingRecord,
  FormType,
  OrgRecord,
  Program,
  SourceFile,
} from "@nonprofits/core";
import type { ImportSource } from "@nonprofits/db";
import { rowsOf } from "./rows.ts";

interface OrgRow {
  ein: string;
  name: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  subsection: string | null;
  ruling_date: string | null;
  in_pub78: 0 | 1;
  revocation_date: string | null;
  reinstatement_date: string | null;
  files_990n: 0 | 1;
  epostcard_website: string | null;
  name_file: string | null;
  name_released_at: string | null;
  name_fetched_at: string | null;
  address_file: string | null;
  address_released_at: string | null;
  address_fetched_at: string | null;
  bmf_file: string | null;
  bmf_released_at: string | null;
  bmf_fetched_at: string | null;
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
  mission_on_schedule_o: 0 | 1;
  file: string;
  released_at: string;
  fetched_at: string;
}

interface RunRow {
  source: ImportSource;
  file: string;
  released_at: string;
  fetched_at: string;
}

const ORG_SQL = `
SELECT o.ein, o.name, o.street, o.city, o.state, o.zip, o.subsection, o.ruling_date,
  o.in_pub78, o.revocation_date, o.reinstatement_date, o.files_990n, o.epostcard_website,
  n.file_url AS name_file, n.released_at AS name_released_at, n.fetched_at AS name_fetched_at,
  a.file_url AS address_file, a.released_at AS address_released_at, a.fetched_at AS address_fetched_at,
  b.file_url AS bmf_file, b.released_at AS bmf_released_at, b.fetched_at AS bmf_fetched_at
FROM orgs o
LEFT JOIN import_runs n ON n.id = o.name_run_id
LEFT JOIN import_runs a ON a.id = o.address_run_id
LEFT JOIN import_runs b ON b.id = o.bmf_run_id
WHERE o.ein = ?1`;

const FILING_SQL = `
SELECT f.object_id, f.form_type, f.tax_year, f.mission, f.activity_summary, f.website,
  f.total_revenue, f.total_expenses, f.total_assets_eoy, f.mission_on_schedule_o,
  i.file_url AS file, i.released_at, i.fetched_at
FROM filings f
JOIN import_runs i ON i.id = f.run_id
WHERE f.ein = ?1`;

const PROGRAMS_SQL = `
SELECT p.description, p.expense, p.grants, p.revenue
FROM programs p
JOIN filings f ON f.ein = p.ein AND f.object_id = p.object_id
WHERE p.ein = ?1
ORDER BY p.rank`;

/** Membership columns on `orgs` are as of these runs; each max(id) is an index seek. */
const LATEST_RUNS_SQL = `
SELECT source, file_url AS file, released_at, fetched_at
FROM import_runs
WHERE id IN (
  SELECT max(id) FROM import_runs WHERE source = 'pub78'
  UNION ALL SELECT max(id) FROM import_runs WHERE source = 'revocation'
  UNION ALL SELECT max(id) FROM import_runs WHERE source = 'epostcard'
  UNION ALL SELECT max(id) FROM import_runs WHERE source = 'efile_xml'
)`;

/** Reads one EIN in a single round trip to the data database: `OrgReader.read`. */
export async function readOrg(
  db: Client,
  ein: string,
): Promise<OrgRecord | null> {
  const [orgs, filings, programs, runs] = await db.batch(
    [
      { sql: ORG_SQL, args: [ein] },
      { sql: FILING_SQL, args: [ein] },
      { sql: PROGRAMS_SQL, args: [ein] },
      LATEST_RUNS_SQL,
    ],
    "read",
  );
  const org = rowsOf<OrgRow>(orgs)[0];
  if (org === undefined) return null;
  const latest = new Map(
    rowsOf<RunRow>(runs).map((r) => [
      r.source,
      source(r.file, r.released_at, r.fetched_at),
    ]),
  );
  const filing = rowsOf<FilingRow>(filings)[0];
  return toRecord(
    org,
    filing ? toFiling(filing, rowsOf<Program>(programs).map(program)) : null,
    latest,
  );
}

/** A plain object: a driver row also carries its columns by index. */
function program(row: Program): Program {
  return {
    description: row.description,
    expense: row.expense,
    grants: row.grants,
    revenue: row.revenue,
  };
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

function toRecord(
  row: OrgRow,
  filing: FilingRecord | null,
  latest: Map<ImportSource, SourceFile | null>,
): OrgRecord {
  const nameSource = source(
    row.name_file,
    row.name_released_at,
    row.name_fetched_at,
  );
  const addressSource = source(
    row.address_file,
    row.address_released_at,
    row.address_fetched_at,
  );
  const bmfSource = source(
    row.bmf_file,
    row.bmf_released_at,
    row.bmf_fetched_at,
  );
  const pub78 = latest.get("pub78");
  const revocation = latest.get("revocation");
  const epostcard = latest.get("epostcard");
  return {
    ein: row.ein,
    name:
      row.name !== null && nameSource
        ? { value: row.name, source: nameSource }
        : null,
    address: addressSource && {
      value: {
        street: row.street,
        city: row.city,
        state: row.state,
        zip: row.zip,
      },
      source: addressSource,
    },
    bmf:
      row.subsection !== null && bmfSource
        ? {
            subsection: row.subsection,
            rulingDate: row.ruling_date,
            source: bmfSource,
          }
        : null,
    pub78: pub78 ? { listed: row.in_pub78 === 1, source: pub78 } : null,
    revocation: revocation
      ? {
          revokedOn: row.revocation_date,
          reinstatedOn: row.reinstatement_date,
          source: revocation,
        }
      : null,
    epostcard: epostcard
      ? {
          filer: row.files_990n === 1,
          website: row.epostcard_website,
          source: epostcard,
        }
      : null,
    efile: latest.get("efile_xml") ? { filing } : null,
  };
}

function toFiling(row: FilingRow, programs: Program[]): FilingRecord {
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
    missionOnScheduleO: row.mission_on_schedule_o === 1,
    programs,
    source: {
      file: row.file,
      releasedAt: row.released_at,
      fetchedAt: row.fetched_at,
    },
  };
}
