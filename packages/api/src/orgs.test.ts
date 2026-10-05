import type { OrgResponse } from "@nonprofits/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { freshClient, type TestApi, testApi } from "./test-support.ts";

let api: TestApi;

beforeAll(async () => {
  api = await testApi();
});

afterAll(async () => {
  await api.dispose();
});

/** Each from its own client, so no request here meets another's quota. */
function fetchKeyless(path: string, method = "GET") {
  return api.app.request(path, { method, headers: freshClient() });
}

async function getOrg(path: string) {
  const response = await fetchKeyless(path);
  return { response, body: (await response.json()) as OrgResponse };
}

describe("GET /v1/orgs/:ein", () => {
  test("answers the Red Cross with every contract field", async () => {
    const { response, body } = await getOrg("/v1/orgs/530196605");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const bmf = {
      file: "https://www.irs.gov/pub/irs-soi/eo_dc.csv",
      releasedAt: "2026-09-08T12:00:00.000Z",
      fetchedAt: "2026-09-10T03:00:00.000Z",
    };
    const filing = {
      file: "https://apps.irs.gov/pub/epostcard/990/xml/2026/2026_TEOS_XML_05A.zip",
      releasedAt: "2026-09-04T12:00:00.000Z",
      fetchedAt: "2026-09-10T03:10:00.000Z",
      objectId: "202511319349301234",
      taxYear: 2024,
      formType: "990",
    };
    expect(body).toStrictEqual({
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
        "The American Red Cross prevents and alleviates human suffering in the face of emergencies by mobilizing the power of volunteers and the generosity of donors.",
      activitySummary:
        "Disaster relief, biomedical services, training and services to the armed forces.",
      programs: [
        {
          description:
            "Biomedical services: collection, testing and distribution of blood products.",
          expense: 1912000000,
          grants: 0,
          revenue: 1850000000,
        },
        {
          description:
            "Disaster services: shelter, food, emotional support and recovery assistance.",
          expense: 701000000,
          grants: 92000000,
          revenue: null,
        },
        {
          description:
            "Training services: first aid, CPR and lifeguard certification.",
          expense: 151000000,
          grants: null,
          revenue: 143000000,
        },
      ],
      finances: {
        revenue: 3215000000,
        expenses: 3108000000,
        assets: 4021000000,
        taxYear: 2024,
      },
      website: "https://www.redcross.org",
      notes: [],
      provenance: {
        name: bmf,
        address: bmf,
        is501c3: bmf,
        deductible: {
          file: "https://apps.irs.gov/pub/epostcard/data-download-pub78.zip",
          releasedAt: "2026-09-01T12:00:00.000Z",
          fetchedAt: "2026-09-10T03:05:00.000Z",
        },
        revoked: {
          file: "https://apps.irs.gov/pub/epostcard/data-download-revocation.zip",
          releasedAt: "2026-09-02T12:00:00.000Z",
          fetchedAt: "2026-09-10T03:06:00.000Z",
        },
        revocationDate: null,
        reinstatementDate: null,
        mission: filing,
        activitySummary: filing,
        programs: filing,
        finances: filing,
        website: filing,
      },
    });
  });

  test("normalizes 53-0196605 to the same org", async () => {
    const hyphenated = await getOrg("/v1/orgs/53-0196605");
    const bare = await getOrg("/v1/orgs/530196605");
    expect(hyphenated.response.status).toBe(200);
    expect(hyphenated.body).toStrictEqual(bare.body);
  });

  test.each(["abc", "53019660", "5301966050"])(
    "refuses %j with a 400 naming the format",
    async (ein) => {
      const response = await fetchKeyless(`/v1/orgs/${ein}`);
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe(
        "application/problem+json",
      );
      expect(await response.json()).toStrictEqual({
        type: "about:blank",
        title: "Bad Request",
        status: 400,
        code: "invalid_ein",
        detail: "EIN must be 9 digits, written 123456789 or 12-3456789.",
      });
    },
  );

  test("answers 404 not found for a well-formed unknown EIN", async () => {
    const response = await fetchKeyless("/v1/orgs/999999999");
    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      code: "not_found",
      detail: "No organization with EIN 999999999 found.",
    });
  });

  test("answers a route miss with a code distinct from an unknown EIN", async () => {
    const response = await fetchKeyless("/v1/orgs/530196605/");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "route_not_found" });
  });

  test("answers a revoked org absent from the BMF as revoked, not 404", async () => {
    const { response, body } = await getOrg("/v1/orgs/311234567");
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      name: "DEFUNCT ARTS COUNCIL",
      is501c3: null,
      revoked: true,
      revocationDate: "2019-05-15",
    });
    expect(body.provenance.name).toStrictEqual({
      file: "https://apps.irs.gov/pub/epostcard/data-download-revocation.zip",
      releasedAt: "2026-09-02T12:00:00.000Z",
      fetchedAt: "2026-09-10T03:06:00.000Z",
    });
    expect(body.notes).toContain("revoked; not in the current BMF");
  });

  test("answers 405 for a method other than GET", async () => {
    const response = await fetchKeyless("/v1/orgs/530196605", "POST");
    expect(response.status).toBe(405);
    // HEAD is served too: Hono answers it from the GET route
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(await response.json()).toMatchObject({
      code: "method_not_allowed",
    });
  });

  test("answers the 990-N fixture with org facts, null mission and the 990-N note", async () => {
    const { body } = await getOrg("/v1/orgs/271234567");
    expect(body).toMatchObject({
      name: "SUNNYSIDE YOUTH SOCCER LEAGUE",
      is501c3: true,
      deductible: true,
      mission: null,
      finances: null,
      website: "sunnysidesoccer.example",
      notes: ["990-N filer: no mission on record"],
    });
    expect(body.provenance.website).toStrictEqual({
      file: "https://apps.irs.gov/pub/epostcard/data-download-epostcard.zip",
      releasedAt: "2026-09-03T12:00:00.000Z",
      fetchedAt: "2026-09-10T03:07:00.000Z",
    });
  });

  test("answers the 990-PF fixture with finances, null mission and its note", async () => {
    const { body } = await getOrg("/v1/orgs/136009999");
    expect(body).toMatchObject({
      mission: null,
      programs: [],
      finances: {
        revenue: 12500000,
        expenses: 9800000,
        assets: 210000000,
        taxYear: 2024,
      },
      notes: ["990-PF: no mission or programs on the form"],
    });
    expect(body.provenance.finances).toMatchObject({
      objectId: "202501239349100500",
      formType: "990-PF",
      taxYear: 2024,
    });
  });

  test("answers the Schedule O fixture with null mission and the Schedule O note", async () => {
    const { body } = await getOrg("/v1/orgs/010654321");
    expect(body).toMatchObject({
      name: "HARBORVIEW LITERACY PROJECT",
      mission: null,
      activitySummary:
        "Free tutoring and book distribution for adult learners.",
      notes: [
        "mission is on Schedule O, not extracted",
        "latest 990 lists no programs",
      ],
    });
    expect(body.provenance.mission).toBeNull();
    expect(body.provenance.finances).toMatchObject({
      objectId: "202531329349300421",
      formType: "990",
    });
  });

  test("answers the revoked fixture as revoked with its date", async () => {
    const { body } = await getOrg("/v1/orgs/201234567");
    expect(body).toMatchObject({
      revoked: true,
      revocationDate: "2023-05-15",
      deductible: false,
      notes: [
        "no e-filed 990 in the last 3 release years",
        "no website on record",
      ],
    });
  });

  test("answers an org the BMF recognized again after its revocation as not revoked, citing the BMF", async () => {
    const { body } = await getOrg("/v1/orgs/461234567");
    expect(body).toMatchObject({
      revoked: false,
      revocationDate: "2021-05-17",
      reinstatementDate: null,
      notes: [
        "reinstated per the current BMF ruling date; the revocation list shows no reinstatement yet",
        "no e-filed 990 in the last 3 release years",
        "no website on record",
      ],
    });
    expect(body.provenance.revoked).toStrictEqual({
      file: "https://www.irs.gov/pub/irs-soi/eo_dc.csv",
      releasedAt: "2026-09-08T12:00:00.000Z",
      fetchedAt: "2026-09-10T03:00:00.000Z",
    });
  });

  test("answers the 501(c)(4) fixture as not 501(c)(3)", async () => {
    const { body } = await getOrg("/v1/orgs/521234567");
    expect(body).toMatchObject({
      is501c3: false,
      deductible: false,
      mission:
        "Promote civic engagement and neighborhood improvement in Riverton.",
    });
    expect(body.provenance.mission).toMatchObject({ formType: "990-EZ" });
  });
});
