import { describe, expect, test } from "vitest";
import { lookupOrg } from "./lookup.ts";
import type { OrgReader, OrgRecord } from "./org.ts";

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

const BMF = {
  file: "https://www.irs.gov/pub/irs-soi/eo1.csv",
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
const INDEX_2026 = {
  file: "https://apps.irs.gov/pub/epostcard/990/xml/2026/index_2026.csv",
  releasedAt: "2026-09-04T12:00:00.000Z",
  fetchedAt: "2026-09-10T03:10:00.000Z",
};

function redCross(): OrgRecord {
  return {
    ein: "530196605",
    name: "AMERICAN NATIONAL RED CROSS",
    address: {
      street: "431 18TH ST NW",
      city: "WASHINGTON",
      state: "DC",
      zip: "20006-5310",
    },
    subsection: "03",
    bmf: BMF,
    pub78: { deductible: true, source: PUB78 },
    revocation: { revoked: false, date: null, source: REVOCATION },
    epostcard: null,
    filing: {
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
      source: INDEX_2026,
    },
  };
}

const RED_CROSS_990 = {
  ...INDEX_2026,
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
      org: {
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
    const record: OrgRecord = {
      ...redCross(),
      ein: "861234567",
      name: "LAKESIDE GARDEN CLUB",
      epostcard: { website: "lakesidegardenclub.org", source: EPOSTCARD },
      filing: null,
    };
    const result = await lookupOrg("861234567", readerOf(record));
    if (!result.ok) throw new Error(result.error.message);
    const { org } = result;
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
    const record: OrgRecord = {
      ...redCross(),
      ein: "136009999",
      name: "HYPOTHETICAL FAMILY FOUNDATION",
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
        source: INDEX_2026,
      },
    };
    const result = await lookupOrg("136009999", readerOf(record));
    if (!result.ok) throw new Error(result.error.message);
    const { org } = result;
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
        ...INDEX_2026,
        objectId: "202501239349100500",
        taxYear: 2024,
        formType: "990-PF",
      },
    });
  });

  test("notes an org with no filing and no e-Postcard", async () => {
    const record: OrgRecord = { ...redCross(), epostcard: null, filing: null };
    const result = await lookupOrg("530196605", readerOf(record));
    if (!result.ok) throw new Error(result.error.message);
    expect(result.org.notes).toStrictEqual([
      "no e-filed 990 in the last 3 release years",
      "no website on record",
    ]);
  });

  test("notes a 990-N filer whose e-Postcard has no website", async () => {
    const record: OrgRecord = {
      ...redCross(),
      epostcard: { website: null, source: EPOSTCARD },
      filing: null,
    };
    const result = await lookupOrg("530196605", readerOf(record));
    if (!result.ok) throw new Error(result.error.message);
    expect(result.org.website).toBeNull();
    expect(result.org.provenance.website).toBeNull();
    expect(result.org.notes).toStrictEqual([
      "990-N filer: no mission on record",
      "no website on record",
    ]);
  });

  test("falls back to the e-Postcard website when the 990 has none", async () => {
    const base = redCross();
    if (!base.filing) throw new Error("fixture has a filing");
    const record: OrgRecord = {
      ...base,
      epostcard: { website: "redcross.example", source: EPOSTCARD },
      filing: { ...base.filing, website: null },
    };
    const result = await lookupOrg("530196605", readerOf(record));
    if (!result.ok) throw new Error(result.error.message);
    expect(result.org.website).toBe("redcross.example");
    expect(result.org.provenance.website).toStrictEqual(EPOSTCARD);
  });

  test("answers a revoked org with its revocation date and source", async () => {
    const record: OrgRecord = {
      ...redCross(),
      revocation: { revoked: true, date: "2023-05-15", source: REVOCATION },
    };
    const result = await lookupOrg("530196605", readerOf(record));
    if (!result.ok) throw new Error(result.error.message);
    expect({
      revoked: result.org.revoked,
      revocationDate: result.org.revocationDate,
      source: result.org.provenance.revoked,
    }).toStrictEqual({
      revoked: true,
      revocationDate: "2023-05-15",
      source: REVOCATION,
    });
  });

  test("answers is501c3 false for a subsection other than 03", async () => {
    const record: OrgRecord = { ...redCross(), subsection: "04" };
    const result = await lookupOrg("530196605", readerOf(record));
    if (!result.ok) throw new Error(result.error.message);
    expect(result.org.is501c3).toBe(false);
  });

  test("answers null with a note for files not yet imported", async () => {
    const record: OrgRecord = { ...redCross(), pub78: null, revocation: null };
    const result = await lookupOrg("530196605", readerOf(record));
    if (!result.ok) throw new Error(result.error.message);
    const { org } = result;
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
    const base = redCross();
    if (!base.filing) throw new Error("fixture has a filing");
    const record: OrgRecord = {
      ...base,
      filing: { ...base.filing, mission: null },
    };
    const result = await lookupOrg("530196605", readerOf(record));
    if (!result.ok) throw new Error(result.error.message);
    expect(result.org.notes).toStrictEqual(["latest 990 states no mission"]);
  });
});
