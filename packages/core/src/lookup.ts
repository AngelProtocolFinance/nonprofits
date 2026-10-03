import { normalizeEin } from "./ein.ts";
import type {
  FilingCitation,
  OrgLookupResult,
  OrgReader,
  OrgRecord,
  OrgResponse,
  SourceFile,
} from "./org.ts";

export async function lookupOrg(
  input: string,
  reader: OrgReader,
): Promise<OrgLookupResult> {
  const ein = normalizeEin(input);
  if (ein === null) {
    return {
      ok: false,
      error: {
        code: "invalid_ein",
        message: "EIN must be 9 digits, written 123456789 or 12-3456789.",
      },
    };
  }
  const record = await reader.read(ein);
  if (record === null) {
    return {
      ok: false,
      error: {
        code: "not_found",
        message: `No organization with EIN ${ein} found.`,
      },
    };
  }
  return { ok: true, org: toResponse(record) };
}

function toResponse(record: OrgRecord): OrgResponse {
  const { filing } = record;
  const citation: FilingCitation | null = filing && {
    ...filing.source,
    objectId: filing.objectId,
    taxYear: filing.taxYear,
    formType: filing.formType,
  };
  const mission = filing?.mission ?? null;
  const activitySummary = filing?.activitySummary ?? null;
  const programs = filing?.programs ?? [];
  const website = pickWebsite(record, citation);

  const notes: string[] = [];
  if (record.pub78 === null) {
    notes.push("Pub 78 not yet imported: deductibility unknown");
  }
  if (record.revocation === null) {
    notes.push(
      "auto-revocation list not yet imported: revocation status unknown",
    );
  }
  if (filing === null) {
    notes.push(
      record.epostcard === null
        ? "no e-filed 990 in the last 3 release years"
        : "990-N filer: no mission on record",
    );
  } else if (filing.formType === "990-PF") {
    notes.push("990-PF: filing facts only");
  } else if (mission === null) {
    notes.push(`latest ${filing.formType} states no mission`);
  }
  if (website === null) notes.push("no website on record");

  return {
    ein: record.ein,
    name: record.name,
    address: record.address,
    is501c3: record.subsection === "03",
    deductible: record.pub78?.deductible ?? null,
    revoked: record.revocation?.revoked ?? null,
    revocationDate: record.revocation?.date ?? null,
    mission,
    activitySummary,
    programs,
    finances: filing && {
      revenue: filing.totalRevenue,
      expenses: filing.totalExpenses,
      assets: filing.totalAssetsEoy,
      taxYear: filing.taxYear,
    },
    website: website?.url ?? null,
    notes,
    provenance: {
      name: record.bmf,
      address: record.bmf,
      is501c3: record.bmf,
      deductible: record.pub78?.source ?? null,
      revoked: record.revocation?.source ?? null,
      mission: mission === null ? null : citation,
      activitySummary: activitySummary === null ? null : citation,
      programs: programs.length === 0 ? null : citation,
      finances: citation,
      website: website?.source ?? null,
    },
  };
}

/** The 990's website wins over the e-Postcard's. */
function pickWebsite(
  record: OrgRecord,
  citation: FilingCitation | null,
): { url: string; source: SourceFile | FilingCitation } | null {
  if (record.filing?.website && citation) {
    return { url: record.filing.website, source: citation };
  }
  if (record.epostcard?.website) {
    return { url: record.epostcard.website, source: record.epostcard.source };
  }
  return null;
}
