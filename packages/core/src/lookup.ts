import { normalizeEin } from "./ein.ts";
import type {
  FilingCitation,
  FoundationStatus,
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
  const websiteUrl = website === null ? null : toWebsiteUrl(website.url);
  const ntee = record.bmf?.ntee ?? null;
  const foundation = foundationOf(record);
  const revocationDate = revocation?.revokedOn ?? null;
  const reinstatementDate = revocation?.reinstatedOn ?? null;
  const revoked = isRevoked(revocation, record.bmf);
  const bmfReinstated = reinstatedPerBmf(revocation, record.bmf);

  return {
    ein: record.ein,
    name: record.name?.value ?? null,
    address: record.address?.value ?? NO_ADDRESS,
    is501c3: is501c3(record.bmf),
    ntee,
    foundationStatus: foundation.status,
    foundationCode: foundation.code,
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
    websiteUrl,
    notes: notesFor(record, {
      mission,
      hasWebsite: website !== null,
      websiteUrl,
      revoked,
      bmfReinstated,
      foundationNote: foundation.note,
    }),
    provenance: {
      name: record.name?.source ?? null,
      address: record.address?.source ?? null,
      is501c3: record.bmf?.source ?? null,
      ntee: ntee === null || record.bmf === null ? null : record.bmf.source,
      foundationStatus: foundation.statusSource,
      foundationCode: foundation.codeSource,
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
      websiteUrl: websiteUrl === null ? null : (website?.source ?? null),
    },
  };
}

interface FoundationFacts {
  status: FoundationStatus | null;
  code: string | null;
  note: string | null;
  statusSource: SourceFile | null;
  codeSource: SourceFile | null;
}

/**
 * IRS Exempt Organizations Business Master File Extract information sheet,
 * FOUNDATION CODE, https://www.irs.gov/pub/irs-soi/eo-info.pdf (00 all
 * organizations except 501(c)(3); 02 and 03 private operating foundations;
 * 04 private non-operating foundation; 09 suspense; 10–18 and 21–24 the
 * public-charity codes the sheet names). This API maps every code from `10`
 * through `24` inclusive to `public_charity`, including `19` and `20`.
 */
function foundationOf(record: OrgRecord): FoundationFacts {
  const source = record.bmf?.source ?? null;
  if (!record.foundationCodeInBuild) {
    return {
      status: null,
      code: null,
      note: "foundation code is not in this data build",
      statusSource: null,
      codeSource: null,
    };
  }
  const code = record.bmf?.foundationCode ?? null;
  if (code === null) {
    return {
      status: null,
      code: null,
      note: "no foundation code on record",
      statusSource: null,
      codeSource: null,
    };
  }
  const status = foundationStatus(code);
  return {
    status,
    code,
    note: status === null ? foundationNote(code) : null,
    statusSource: status === null ? null : source,
    codeSource: source,
  };
}

function foundationStatus(code: string): FoundationStatus | null {
  if (code === "02" || code === "03") return "private_operating_foundation";
  if (code === "04") return "private_foundation";
  if (code.length === 2) {
    const n = Number(code);
    if (Number.isInteger(n) && n >= 10 && n <= 24) return "public_charity";
  }
  return null;
}

function foundationNote(code: string): string {
  if (code === "00") return "not a 501(c)(3): no foundation status";
  if (code === "09") return "foundation status is in suspense";
  return "unrecognized foundation code";
}

function notesFor(
  record: OrgRecord,
  facts: {
    mission: string | null;
    hasWebsite: boolean;
    websiteUrl: string | null;
    revoked: boolean | null;
    bmfReinstated: boolean;
    foundationNote: string | null;
  },
): string[] {
  const {
    mission,
    hasWebsite,
    websiteUrl,
    revoked,
    bmfReinstated,
    foundationNote,
  } = facts;
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
  if (record.bmf === null || record.bmf.ntee === null) {
    notes.push("no NTEE code on record");
  }
  if (foundationNote !== null) notes.push(foundationNote);
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
  else if (websiteUrl === null) {
    notes.push("website is not a valid web address");
  }
  return notes;
}

function toWebsiteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (/^(?:n\/a|none|0)$/i.test(trimmed)) return null;
  if (/[\s@]/.test(trimmed)) return null;

  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  } else if (/^http:\/\//i.test(candidate)) {
    candidate = `https://${candidate.slice(7)}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  const hostname = url.hostname;
  const dot = hostname.lastIndexOf(".");
  if (dot === -1) return null;
  if (!/^[a-z]{2,}$/i.test(hostname.slice(dot + 1))) return null;

  const serialized = url.href.toLowerCase();
  if (url.pathname === "/" && url.search === "" && url.hash === "") {
    return serialized.slice(0, -1);
  }
  return serialized;
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
