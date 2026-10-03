import { normalizeEin } from "./ein.ts";
import type {
  FilingCitation,
  OrgLookupResult,
  OrgReader,
  OrgRecord,
  OrgResponse,
  SourceFile,
} from "./org.ts";
import { is501c3, isDeductible, isRevoked, reinstatedPerBmf } from "./rules.ts";

const NO_ADDRESS = { street: null, city: null, state: null, zip: null };

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
  return { ok: true, value: toResponse(record) };
}

function toResponse(record: OrgRecord): OrgResponse {
  const { revocation } = record;
  const filing = record.efile?.filing ?? null;
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
  const revocationDate = revocation?.revokedOn ?? null;
  const reinstatementDate = revocation?.reinstatedOn ?? null;
  const revoked = isRevoked(revocation, record.bmf);
  const bmfReinstated = reinstatedPerBmf(revocation, record.bmf);

  return {
    ein: record.ein,
    name: record.name?.value ?? null,
    address: record.address?.value ?? NO_ADDRESS,
    is501c3: is501c3(record.bmf),
    deductible: isDeductible(record.pub78),
    revoked,
    revocationDate,
    reinstatementDate,
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
    notes: notesFor(record, {
      mission,
      hasWebsite: website !== null,
      revoked,
      bmfReinstated,
    }),
    provenance: {
      name: record.name?.source ?? null,
      address: record.address?.source ?? null,
      is501c3: record.bmf?.source ?? null,
      deductible: record.pub78?.source ?? null,
      revoked: bmfReinstated
        ? (record.bmf?.source ?? null)
        : (revocation?.source ?? null),
      revocationDate:
        revocationDate === null ? null : (revocation?.source ?? null),
      reinstatementDate:
        reinstatementDate === null ? null : (revocation?.source ?? null),
      mission: mission === null ? null : citation,
      activitySummary: activitySummary === null ? null : citation,
      programs: programs.length === 0 ? null : citation,
      finances: citation,
      website: website?.source ?? null,
    },
  };
}

function notesFor(
  record: OrgRecord,
  facts: {
    mission: string | null;
    hasWebsite: boolean;
    revoked: boolean | null;
    bmfReinstated: boolean;
  },
): string[] {
  const { mission, hasWebsite, revoked, bmfReinstated } = facts;
  const notes: string[] = [];
  if (record.name === null) notes.push("no name on record");
  if (record.address === null) notes.push("no address on record");
  if (record.bmf === null) {
    notes.push(
      revoked
        ? "revoked; not in the current BMF"
        : "not in the current BMF: 501(c)(3) status unknown",
    );
  }
  if (record.pub78 === null) {
    notes.push("Pub 78 not yet imported: deductibility unknown");
  }
  if (record.revocation === null) {
    notes.push(
      "auto-revocation list not yet imported: revocation status unknown",
    );
  }
  if (bmfReinstated) {
    notes.push(
      "reinstated per the current BMF ruling date; the revocation list shows no reinstatement yet",
    );
  }
  const filing = record.efile?.filing ?? null;
  if (record.efile === null) {
    notes.push("990 filings not yet imported");
  } else if (filing === null) {
    notes.push(
      record.epostcard?.filer
        ? "990-N filer: no mission on record"
        : "no e-filed 990 in the last 3 release years",
    );
  } else if (filing.formType === "990-PF") {
    notes.push("990-PF: no mission or programs on the form");
  } else {
    if (mission === null) {
      notes.push(
        filing.missionOnScheduleO
          ? "mission is on Schedule O, not extracted"
          : `latest ${filing.formType} states no mission`,
      );
    }
    if (filing.formType === "990-EZ") {
      notes.push("990-EZ has no activity summary");
    }
    if (filing.programs.length === 0) {
      notes.push(`latest ${filing.formType} lists no programs`);
    }
  }
  if (!hasWebsite) notes.push("no website on record");
  return notes;
}

/** The 990's website wins over the e-Postcard's. */
function pickWebsite(
  record: OrgRecord,
  citation: FilingCitation | null,
): { url: string; source: SourceFile | FilingCitation } | null {
  const filingWebsite = record.efile?.filing?.website;
  if (filingWebsite && citation) {
    return { url: filingWebsite, source: citation };
  }
  if (record.epostcard?.website) {
    return { url: record.epostcard.website, source: record.epostcard.source };
  }
  return null;
}
