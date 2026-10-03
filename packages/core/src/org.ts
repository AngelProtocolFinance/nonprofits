/** An IRS bulk file a fact was read from. */
export interface SourceFile {
  /** URL the file was downloaded from. */
  file: string;
  /** The file's `Last-Modified`, ISO-8601. */
  releasedAt: string;
  /** When the import fetched it, ISO-8601. */
  fetchedAt: string;
}

export type FormType = "990" | "990-EZ" | "990-PF";

/** A filing fact's source: the release file plus the return it came from. */
export interface FilingCitation extends SourceFile {
  objectId: string;
  taxYear: number;
  formType: FormType;
}

export interface Address {
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export interface Program {
  description: string | null;
  expense: number | null;
  grants: number | null;
  revenue: number | null;
}

export interface Finances {
  revenue: number | null;
  expenses: number | null;
  /** Total assets, end of year. */
  assets: number | null;
  taxYear: number;
}

/** Where each fact in an `OrgResponse` came from; null where the fact is null. */
export interface Provenance {
  name: SourceFile;
  address: SourceFile;
  is501c3: SourceFile;
  deductible: SourceFile | null;
  revoked: SourceFile | null;
  mission: FilingCitation | null;
  activitySummary: FilingCitation | null;
  programs: FilingCitation | null;
  finances: FilingCitation | null;
  website: SourceFile | FilingCitation | null;
}

/** `GET /v1/orgs/:ein` and the MCP lookup tool both answer with this shape. */
export interface OrgResponse {
  ein: string;
  name: string;
  address: Address;
  /** BMF subsection `03`. */
  is501c3: boolean;
  /** Listed in Pub 78; null until that file is imported. */
  deductible: boolean | null;
  /** On the auto-revocation list; null until that file is imported. */
  revoked: boolean | null;
  /** `YYYY-MM-DD`. */
  revocationDate: string | null;
  mission: string | null;
  activitySummary: string | null;
  /** At most 3, highest expense first. */
  programs: Program[];
  finances: Finances | null;
  website: string | null;
  /** Why a fact is null. */
  notes: string[];
  provenance: Provenance;
}

export type OrgLookupError =
  | { code: "invalid_ein"; message: string }
  | { code: "not_found"; message: string };

export type OrgLookupResult =
  | { ok: true; org: OrgResponse }
  | { ok: false; error: OrgLookupError };

export interface FilingRecord {
  objectId: string;
  formType: FormType;
  taxYear: number;
  mission: string | null;
  activitySummary: string | null;
  website: string | null;
  totalRevenue: number | null;
  totalExpenses: number | null;
  totalAssetsEoy: number | null;
  /** Ordered by rank, at most 3. */
  programs: Program[];
  source: SourceFile;
}

/** Everything stored about one EIN, as an `OrgReader` returns it. */
export interface OrgRecord {
  ein: string;
  name: string;
  address: Address;
  subsection: string;
  bmf: SourceFile;
  /** null until Pub 78 is imported. */
  pub78: { deductible: boolean; source: SourceFile } | null;
  /** null until the auto-revocation list is imported. */
  revocation: {
    revoked: boolean;
    date: string | null;
    source: SourceFile;
  } | null;
  /** Present only for 990-N (e-Postcard) filers. */
  epostcard: { website: string | null; source: SourceFile } | null;
  filing: FilingRecord | null;
}

/** The storage seam: the Worker satisfies it with D1. */
export interface OrgReader {
  read(ein: string): Promise<OrgRecord | null>;
}
