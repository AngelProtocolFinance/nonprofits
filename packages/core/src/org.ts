import type { Result } from "./result.ts";

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
  name: SourceFile | null;
  address: SourceFile | null;
  is501c3: SourceFile | null;
  deductible: SourceFile | null;
  revoked: SourceFile | null;
  revocationDate: SourceFile | null;
  reinstatementDate: SourceFile | null;
  mission: FilingCitation | null;
  activitySummary: FilingCitation | null;
  programs: FilingCitation | null;
  finances: FilingCitation | null;
  website: SourceFile | FilingCitation | null;
}

/** `GET /v1/orgs/:ein` and the MCP lookup tool both answer with this shape. */
export interface OrgResponse {
  ein: string;
  name: string | null;
  address: Address;
  /** BMF subsection `03`; null when the org is not in the current BMF. */
  is501c3: boolean | null;
  /** Listed in Pub 78; null until that file is imported. */
  deductible: boolean | null;
  /** Revoked and not reinstated since; null until the revocation list is imported. */
  revoked: boolean | null;
  /** `YYYY-MM-DD`. */
  revocationDate: string | null;
  /** `YYYY-MM-DD`. */
  reinstatementDate: string | null;
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

export type OrgLookupResult = Result<OrgResponse, OrgLookupError>;

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
  /** The mission field only points to Schedule O, which is not extracted; `mission` is null. */
  missionOnScheduleO: boolean;
  /** Ordered by rank, at most 3. */
  programs: Program[];
  /** The e-file XML zip the return was read from. */
  source: SourceFile;
}

/**
 * Everything stored about one EIN, as an `OrgReader` returns it. A null list
 * (`pub78`, `revocation`, `epostcard`, `efile`) means that file has not been
 * imported yet; its source is the latest import of it.
 */
export interface OrgRecord {
  ein: string;
  name: { value: string; source: SourceFile } | null;
  address: { value: Address; source: SourceFile } | null;
  /** null when the org is not in the current BMF. */
  bmf: { subsection: string; source: SourceFile } | null;
  pub78: { listed: boolean; source: SourceFile } | null;
  /** Dates are null when the org is not on the list. */
  revocation: {
    revokedOn: string | null;
    reinstatedOn: string | null;
    source: SourceFile;
  } | null;
  epostcard: {
    filer: boolean;
    website: string | null;
    source: SourceFile;
  } | null;
  efile: { filing: FilingRecord | null } | null;
}

/** The storage seam: the Worker satisfies it with D1. */
export interface OrgReader {
  read(ein: string): Promise<OrgRecord | null>;
}
