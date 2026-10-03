import { describe, expect, test } from "vitest";
import { lookupOrg } from "./lookup.ts";
import type { FilingRecord, OrgReader, OrgRecord, OrgResponse } from "./org.ts";

function readerOf(...records: OrgRecord[]): OrgReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async read(ein) {
      reads.push(ein);
      return records.find((r) => r.ein === ein) ?? null;
    },
  };
}

async function lookup(record: OrgRecord): Promise<OrgResponse> {
  const result = await lookupOrg(record.ein, readerOf(record));
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const BMF = {
  file: "https://www.irs.gov/pub/irs-soi/eo_dc.csv",
  releasedAt: "2026-09-08T12:00:00.000Z",
  fetchedAt: "2026-09-10T03:00:00.000Z",
};
const PUB78 = {
  file: "https://apps.irs.gov/pub/epostcard/data-download-pub78.zip",
  releasedAt: "2026-09-01T12:00:00.000Z",
  fetchedAt: "2026-09-10T03:05:00.000Z",
};
const REVOCATION = {
  file: "https://apps.irs.gov/pub/epostcard/data-download-revocation.zip",
  releasedAt: "2026-09-02T12:00:00.000Z",
  fetchedAt: "2026-09-10T03:06:00.000Z",
};
const EPOSTCARD = {
  file: "https://apps.irs.gov/pub/epostcard/data-download-epostcard.zip",
  releasedAt: "2026-09-03T12:00:00.000Z",
  fetchedAt: "2026-09-10T03:07:00.000Z",
};
const XML_ZIP = {
  file: "https://apps.irs.gov/pub/epostcard/990/xml/2026/2026_TEOS_XML_05A.zip",
  releasedAt: "2026-09-04T12:00:00.000Z",
  fetchedAt: "2026-09-10T03:10:00.000Z",
};

function redCrossFiling(): FilingRecord {
  return {
    objectId: "202511319349301234",
    formType: "990",
    taxYear: 2024,
    mission:
      "Prevent and alleviate human suffering in the face of emergencies.",
    activitySummary: "Disaster relief, blood services and training.",
    website: "https://www.redcross.org",
    totalRevenue: 3_200_000_000,
    totalExpenses: 3_100_000_000,
    totalAssetsEoy: 4_000_000_000,
    programs: [
      {
        description: "Biomedical services",
        expense: 1_900_000_000,
        grants: 0,
        revenue: 1_800_000_000,
      },
      {
        description: "Disaster services",
        expense: 700_000_000,
        grants: 90_000_000,
        revenue: null,
      },
      {
        description: "Training services",
        expense: 150_000_000,
        grants: null,
        revenue: 140_000_000,
      },
    ],
    source: XML_ZIP,
  };
}

function redCross(): OrgRecord {
  return {
    ein: "530196605",
    name: { value: "AMERICAN NATIONAL RED CROSS", source: BMF },
    address: {
      value: {
        street: "431 18TH ST NW",
        city: "WASHINGTON",
        state: "DC",
        zip: "20006-5310",
      },
      source: BMF,
    },
    bmf: { subsection: "03", source: BMF },
    pub78: { listed: true, source: PUB78 },
    revocation: { revokedOn: null, reinstatedOn: null, source: REVOCATION },
    epostcard: { filer: false, website: null, source: EPOSTCARD },
    efile: { filing: redCrossFiling() },
  };
}

const RED_CROSS_990 = {
  ...XML_ZIP,
  objectId: "202511319349301234",
  taxYear: 2024,
  formType: "990",
};

describe("lookupOrg", () => {
  test.each(["abc", "12345678", "1234567890"])(
    "refuses %j without reading storage",
    async (input) => {
      const reader = readerOf();
      const result = await lookupOrg(input, reader);
      expect(result).toEqual({
        ok: false,
        error: {
          code: "invalid_ein",
          message: expect.stringContaining("12-3456789"),
        },
      });
      expect(reader.reads).toEqual([]);
    },
  );

  test("answers not_found for a well-formed EIN with no record", async () => {
    const result = await lookupOrg("12-3456789", readerOf());
    expect(result).toEqual({
      ok: false,
      error: {
        code: "not_found",
        message: "No organization with EIN 123456789 found.",
      },
    });
  });

  test("answers a 990 filer with every fact and its source", async () => {
    const result = await lookupOrg("530196605", readerOf(redCross()));
    expect(result).toStrictEqual({
      ok: true,
      value: {
        ein: "530196605",
        name: "AMERICAN NATIONAL RED CROSS",
        address: {
          street: "431 18TH ST NW",
          city: "WASHINGTON",
          state: "DC",
          zip: "20006-5310",
        },
        is501c3: true,
        deductible: true,
        revoked: false,
        revocationDate: null,
        reinstatementDate: null,
        mission:
          "Prevent and alleviate human suffering in the face of emergencies.",
        activitySummary: "Disaster relief, blood services and training.",
        programs: [
          {
            description: "Biomedical services",
            expense: 1_900_000_000,
            grants: 0,
            revenue: 1_800_000_000,
          },
          {
            description: "Disaster services",
            expense: 700_000_000,
            grants: 90_000_000,
            revenue: null,
          },
          {
            description: "Training services",
            expense: 150_000_000,
            grants: null,
            revenue: 140_000_000,
          },
        ],
        finances: {
          revenue: 3_200_000_000,
          expenses: 3_100_000_000,
          assets: 4_000_000_000,
          taxYear: 2024,
        },
        website: "https://www.redcross.org",
        notes: [],
        provenance: {
          name: BMF,
          address: BMF,
          is501c3: BMF,
          deductible: PUB78,
          revoked: REVOCATION,
          revocationDate: null,
          reinstatementDate: null,
          mission: RED_CROSS_990,
          activitySummary: RED_CROSS_990,
          programs: RED_CROSS_990,
          finances: RED_CROSS_990,
          website: RED_CROSS_990,
        },
      },
    });
  });

  test("answers a 990-N filer with org facts, the e-Postcard website and a note", async () => {
    const org = await lookup({
      ...redCross(),
      epostcard: {
        filer: true,
        website: "lakesidegardenclub.org",
        source: EPOSTCARD,
      },
      efile: { filing: null },
    });
    expect({
      mission: org.mission,
      activitySummary: org.activitySummary,
      programs: org.programs,
      finances: org.finances,
      website: org.website,
      notes: org.notes,
    }).toStrictEqual({
      mission: null,
      activitySummary: null,
      programs: [],
      finances: null,
      website: "lakesidegardenclub.org",
      notes: ["990-N filer: no mission on record"],
    });
    expect(org.provenance).toMatchObject({
      name: BMF,
      mission: null,
      activitySummary: null,
      programs: null,
      finances: null,
      website: EPOSTCARD,
    });
  });

  test("answers a 990-PF filer with finances, no mission and a note", async () => {
    const org = await lookup({
      ...redCross(),
      efile: {
        filing: {
          objectId: "202501239349100500",
          formType: "990-PF",
          taxYear: 2024,
          mission: null,
          activitySummary: null,
          website: "https://hff.example.org",
          totalRevenue: 12_500_000,
          totalExpenses: 9_800_000,
          totalAssetsEoy: 210_000_000,
          programs: [],
          source: XML_ZIP,
        },
      },
    });
    expect({
      mission: org.mission,
      finances: org.finances,
      notes: org.notes,
      missionSource: org.provenance.mission,
      financesSource: org.provenance.finances,
    }).toStrictEqual({
      mission: null,
      finances: {
        revenue: 12_500_000,
        expenses: 9_800_000,
        assets: 210_000_000,
        taxYear: 2024,
      },
      notes: ["990-PF: filing facts only"],
      missionSource: null,
      financesSource: {
        ...XML_ZIP,
        objectId: "202501239349100500",
        taxYear: 2024,
        formType: "990-PF",
      },
    });
  });

  test("notes an org with no filing and no e-Postcard", async () => {
    const org = await lookup({ ...redCross(), efile: { filing: null } });
    expect(org.notes).toStrictEqual([
      "no e-filed 990 in the last 3 release years",
      "no website on record",
    ]);
  });

  test("notes a 990-N filer whose e-Postcard has no website", async () => {
    const org = await lookup({
      ...redCross(),
      epostcard: { filer: true, website: null, source: EPOSTCARD },
      efile: { filing: null },
    });
    expect(org.website).toBeNull();
    expect(org.provenance.website).toBeNull();
    expect(org.notes).toStrictEqual([
      "990-N filer: no mission on record",
      "no website on record",
    ]);
  });

  test("falls back to the e-Postcard website when the 990 has none", async () => {
    const org = await lookup({
      ...redCross(),
      epostcard: {
        filer: true,
        website: "redcross.example",
        source: EPOSTCARD,
      },
      efile: { filing: { ...redCrossFiling(), website: null } },
    });
    expect(org.website).toBe("redcross.example");
    expect(org.provenance.website).toStrictEqual(EPOSTCARD);
  });

  test("answers a revoked org with its revocation date and source", async () => {
    const org = await lookup({
      ...redCross(),
      revocation: {
        revokedOn: "2023-05-15",
        reinstatedOn: null,
        source: REVOCATION,
      },
    });
    expect({
      revoked: org.revoked,
      revocationDate: org.revocationDate,
      revokedSource: org.provenance.revoked,
      dateSource: org.provenance.revocationDate,
    }).toStrictEqual({
      revoked: true,
      revocationDate: "2023-05-15",
      revokedSource: REVOCATION,
      dateSource: REVOCATION,
    });
  });

  test("answers is501c3 false for a subsection other than 03", async () => {
    const org = await lookup({
      ...redCross(),
      bmf: { subsection: "04", source: BMF },
    });
    expect(org.is501c3).toBe(false);
  });

  test("answers null with a note for files not yet imported", async () => {
    const org = await lookup({ ...redCross(), pub78: null, revocation: null });
    expect({
      deductible: org.deductible,
      revoked: org.revoked,
      deductibleSource: org.provenance.deductible,
      revokedSource: org.provenance.revoked,
      notes: org.notes,
    }).toStrictEqual({
      deductible: null,
      revoked: null,
      deductibleSource: null,
      revokedSource: null,
      notes: [
        "Pub 78 not yet imported: deductibility unknown",
        "auto-revocation list not yet imported: revocation status unknown",
      ],
    });
  });

  test("notes a 990 that states no mission", async () => {
    const org = await lookup({
      ...redCross(),
      efile: { filing: { ...redCrossFiling(), mission: null } },
    });
    expect(org.notes).toStrictEqual(["latest 990 states no mission"]);
  });

  test("prefers the 990 website over the e-Postcard's and cites the filing", async () => {
    const org = await lookup({
      ...redCross(),
      epostcard: {
        filer: true,
        website: "redcross.example",
        source: EPOSTCARD,
      },
    });
    expect(org.website).toBe("https://www.redcross.org");
    expect(org.provenance.website).toStrictEqual(RED_CROSS_990);
  });

  test("notes that filings are not yet imported instead of guessing none", async () => {
    const org = await lookup({ ...redCross(), efile: null });
    expect({
      mission: org.mission,
      finances: org.finances,
      notes: org.notes,
    }).toStrictEqual({
      mission: null,
      finances: null,
      notes: ["990 filings not yet imported", "no website on record"],
    });
  });

  test("answers a revoked org absent from the BMF from the revocation list", async () => {
    const org = await lookup({
      ein: "311234567",
      name: { value: "DEFUNCT ARTS COUNCIL", source: REVOCATION },
      address: {
        value: {
          street: "1 OLD RD",
          city: "TOLEDO",
          state: "OH",
          zip: "43604",
        },
        source: REVOCATION,
      },
      bmf: null,
      pub78: { listed: false, source: PUB78 },
      revocation: {
        revokedOn: "2019-05-15",
        reinstatedOn: null,
        source: REVOCATION,
      },
      epostcard: { filer: false, website: null, source: EPOSTCARD },
      efile: { filing: null },
    });
    expect({
      name: org.name,
      is501c3: org.is501c3,
      revoked: org.revoked,
      nameSource: org.provenance.name,
      addressSource: org.provenance.address,
      is501c3Source: org.provenance.is501c3,
      notes: org.notes,
    }).toStrictEqual({
      name: "DEFUNCT ARTS COUNCIL",
      is501c3: null,
      revoked: true,
      nameSource: REVOCATION,
      addressSource: REVOCATION,
      is501c3Source: null,
      notes: [
        "not in the current BMF: 501(c)(3) status unknown",
        "no e-filed 990 in the last 3 release years",
        "no website on record",
      ],
    });
  });

  test("notes an org with no name or address on record", async () => {
    const org = await lookup({ ...redCross(), name: null, address: null });
    expect({
      name: org.name,
      address: org.address,
      nameSource: org.provenance.name,
      addressSource: org.provenance.address,
      notes: org.notes,
    }).toStrictEqual({
      name: null,
      address: { street: null, city: null, state: null, zip: null },
      nameSource: null,
      addressSource: null,
      notes: ["no name on record", "no address on record"],
    });
  });

  test("answers a reinstated org as not revoked, keeping both dates", async () => {
    const org = await lookup({
      ...redCross(),
      revocation: {
        revokedOn: "2020-05-15",
        reinstatedOn: "2021-02-01",
        source: REVOCATION,
      },
    });
    expect({
      revoked: org.revoked,
      revocationDate: org.revocationDate,
      reinstatementDate: org.reinstatementDate,
      reinstatementSource: org.provenance.reinstatementDate,
    }).toStrictEqual({
      revoked: false,
      revocationDate: "2020-05-15",
      reinstatementDate: "2021-02-01",
      reinstatementSource: REVOCATION,
    });
  });
});
