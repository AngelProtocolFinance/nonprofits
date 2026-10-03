import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { parseReturn } from "./efile-xml.ts";

/** Real returns from the IRS batch zips, trimmed after the form itself (the schedules are never read). */
const XML = new URL("../fixtures/efile/xml/", import.meta.url);

function parseFixture(objectId: string) {
  return parseReturn(createReadStream(new URL(`${objectId}_public.xml`, XML)));
}

const RED_CROSS_MISSION =
  "THE AMERICAN RED CROSS PREVENTS AND ALLEVIATES HUMAN SUFFERING IN THE FACE OF EMERGENCIES BY MOBILIZING THE POWER OF VOLUNTEERS AND THE GENEROSITY OF DONORS.";

describe("a Form 990", () => {
  test("yields the Red Cross's mission, website, finances and top programs", async () => {
    const parsed = await parseFixture("202640829349300109");
    expect(parsed).toMatchObject({
      returnVersion: "2024v5.1",
      formType: "990",
      ein: "530196605",
      taxYear: 2024,
      mission: RED_CROSS_MISSION,
      activitySummary: RED_CROSS_MISSION,
      website: "WWW.REDCROSS.ORG",
      totalRevenue: 3_916_983_933,
      totalExpenses: 3_285_857_544,
      totalAssetsEoy: 5_052_941_623,
    });
    expect(parsed.programs).toEqual([
      {
        description: expect.stringMatching(
          /^BIOMEDICAL SERVICES THE ORGANIZATION COLLECTS, PROCESSES AND DISTRIBUTES APPROXIMATELY 40 PERCENT/,
        ),
        expense: 2_119_409_244,
        grants: 0,
        revenue: 2_305_214_618,
      },
      {
        description: expect.stringMatching(
          /^DOMESTIC DISASTER SERVICES: THE AMERICAN RED CROSS RESPONDS/,
        ),
        expense: 591_737_244,
        grants: 231_002_736,
        revenue: 0,
      },
      {
        description:
          "TRAINING SERVICES: THE AMERICAN RED CROSS HELPS PEOPLE PREPARE FOR AND RESPOND TO HEALTH AND SAFETY EMERGENCIES THROUGH OUR LIFESAVING EDUCATION AND TRAINING PROGRAMS. IN FY25, NEARLY 6.3 MILLION PEOPLE RECEIVED RED CROSS TRAINING IN FIRST AID, WATER SAFETY AND OTHER SKILLS THAT HELP SAVE LIVES.",
        expense: 143_102_303,
        grants: 1_063_370,
        revenue: 175_384_737,
      },
    ]);
  });
});

const ART_DEALERS = "NOT FOR PROFIT LEAGUE OF ART & ANTIQUE DEALERS.";
const KRE8IVU =
  "To empower at-risk youth through immersive STEAM learning in music production, audio engineering, and film education.";
const DELTA_TRITON =
  "The mission of Delta Triton Chapter of Phi Sigma Kappa is to grow and stay true to the Cardinal Principles of Phi Sigma Kappa Promoting Brotherhood, Stimulating Scholarship and Developing Character - for the future successes of Delta Kappa.";
/** Delta Triton's programs, its first line ending `return`; its two filings differ only there. */
function deltaTritonPrograms(returning: string) {
  return [
    `Phi Sigma Kappa Delta Triton has been suspended from Purdues campus. They anticipate to return ${returning}.`,
    "Volunteered to walk dogs for a dog shelter in West Lafayette.",
    "Volunteered to help clean Purdue University for a day.",
  ].map((description) => ({
    description,
    expense: null,
    grants: null,
    revenue: null,
  }));
}

/** One real 990 per returnVersion seen in the 2024–2026 batches. */
describe.each([
  {
    objectId: "202620389349300312",
    returnVersion: "2023v6.0",
    ein: "920724925",
    taxYear: 2023,
    mission: DELTA_TRITON,
    website: null, // N/A
    totalRevenue: 314_908,
    totalExpenses: 385_499,
    totalAssetsEoy: 81_989,
    programs: deltaTritonPrograms("in two years"),
  },
  {
    objectId: "202630139349301998",
    returnVersion: "2024v5.0",
    ein: "131520977",
    taxYear: 2024,
    mission: ART_DEALERS,
    website: "ARTANTIQUEDEALERSLEAG.ORG",
    totalRevenue: 42_900,
    totalExpenses: 60_108,
    totalAssetsEoy: 9_649,
    // only line 4d states an expense, so it ranks first; 4a and 4b follow in form order
    programs: [53_756, null, null].map((expense) => ({
      description: ART_DEALERS,
      expense,
      grants: null,
      revenue: null,
    })),
  },
  {
    objectId: "202620339349301487",
    returnVersion: "2024v5.1",
    ein: "813192688",
    taxYear: 2024,
    mission: KRE8IVU,
    website: "HTTPS://KRE8IVU.COM/",
    totalRevenue: 218_813,
    totalExpenses: 148_026,
    totalAssetsEoy: 70_787,
    programs: [KRE8IVU, KRE8IVU, KRE8IVU].map((description) => ({
      description,
      expense: null,
      grants: null,
      revenue: null,
    })),
  },
  {
    objectId: "202640389349300504",
    returnVersion: "2024v5.2",
    ein: "920724925",
    taxYear: 2024,
    mission: DELTA_TRITON,
    website: null, // N/A
    totalRevenue: 42_888,
    totalExpenses: 109_009,
    totalAssetsEoy: 15_868,
    programs: deltaTritonPrograms("in one year"),
  },
  {
    objectId: "202620149349301082",
    returnVersion: "2024v5.5",
    ein: "203349625",
    taxYear: 2024,
    mission: "DEDCATION TO VERIOS PROGRAMS WITH DEVERSE NEEDS.",
    website: null, // N/A
    totalRevenue: 24_413,
    totalExpenses: 20_021,
    totalAssetsEoy: 79_208,
    // line 4b's expense outranks 4a's; 4c states none
    programs: [
      [15_325, "DEVERSE NEEDS"],
      [4_696, "DEDICATION TO VARIOS PROGRAMS"],
      [null, "DEDICATION TO VARIOS PROGRAMS"],
    ].map(([expense, description]) => ({
      description,
      expense,
      grants: null,
      revenue: null,
    })),
  },
  {
    objectId: "202631339349308133",
    returnVersion: "2025v4.1",
    ein: "394993812",
    taxYear: 2025,
    mission:
      "THE CORPORATION IS ORGANIZED EXCLUSIVELY FOR CHARITABLE, RELIGIOUS, EDUCATIONAL, AND SCIENTIFIC PURPOSES UNDER SECTION 501(C)(3) OF THE INTERNAL REVENUE CODE, OR CORRESPONDING SECTION OF ANY FUTURE FEDERAL TAX CODE",
    website: "www.daretoloveministries.org",
    totalRevenue: 0,
    totalExpenses: 0,
    totalAssetsEoy: 0,
    // every program line reads NONE
    programs: [],
  },
  // expected values below read off each file with ElementTree, independently of this parser
  {
    objectId: "202212539349300306",
    returnVersion: "2019v5.0",
    ein: "815436769",
    taxYear: 2019,
    mission:
      "THE MISSION OF THE CAPITOL HILL JAZZ FOUNDATION IS TO SERVE THE WASHINGTON, D.C. JAZZ COMMUNITY BY PROVIDING A WEEKLY JAM SESSION, ANNUAL JAZZ FESTIVAL AND ARTS ADVOCACY ON BEHALF OF D.C. JAZZ MUSICIANS. OUR VISION IS TO FINANCIALLY ASSIST WASHINGTON D.C. BASED JAZZ MUSICIANS, VENUES AND JAZZ EDUCATION PROGRAMS.",
    website: "WWW.CAPITOLHILLJAZZFOUNDATION.ORG",
    totalRevenue: 116283,
    totalExpenses: 107842,
    totalAssetsEoy: 8437,
    programs: [
      {
        description:
          "THE HILLFEST JAZZ CONFERENCE AND FESTIVAL IS AN ANNUAL WEEK-LONG MUSIC CONFERENCE CONCLUDING WITH A DAY LONG MUSIC FESTIVAL HELD OUTDOORS IN THE CAPITOL HILL NEIGHBORHOOD THE FIRST WEEK IN OCTOBER.",
        expense: 69732,
        grants: null,
        revenue: 11700,
      },
      {
        description:
          "THE CAPITOL HILL JAZZ JAM IS A WEEKLY JAZZ JAM SESSION HELD AT MR. HENRY'S RESTAURANT IN THE CAPITOL HILL NEIGHBORHOOD IN WASHINGTON D.C. EVERY WEDNESDAY EVENING.",
        expense: 2409,
        grants: null,
        revenue: null,
      },
      {
        description:
          "THE HILLFEST MUSIC EXPO IS DESIGNED TO IDENTIFY AND CELEBRATE OUR MUSIC INFRASTRUCTURE, CONNECT MUSICIANS WITH COMPANIES FOR SPONSORSHIPS, AND TO ENCOURAGE LARGE MUSIC OGANIZAIONS TO DO BUSINESS IN D.C. OTHER SPECIAL EVENTS ARE ALSO HOSTED BY THE CAPITAL JAZZ FOUNDATION.",
        expense: 1778,
        grants: null,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202222529349301477",
    returnVersion: "2019v5.1",
    ein: "611758808",
    taxYear: 2019,
    mission:
      "TO SHARE THE LOVE OF CHRIST THROUGH EDUCATIONAL MINISTRIES, EVANGELISTIC OUTREACH, AND HUMANITARIAN EFFORTS.",
    website: "WWW.GLMINDIA.ORG",
    totalRevenue: 1453673,
    totalExpenses: 1188273,
    totalAssetsEoy: 1076410,
    programs: [
      {
        description:
          "OVERSIGHT AND ADMINISTRATION OF EDUCATIONAL, RELIGIOUS, AND HUMANITARIAN AID PROGRAMS.",
        expense: 507533,
        grants: 493000,
        revenue: null,
      },
      {
        description:
          "EDUCATIONAL MINISTRIES CONDUCTED THROUGH VARIOUS DAY SCHOOLS, VACATION BIBLE SCHOOL, AND WEEKLY GOOD LIFE CLUBS",
        expense: 325057,
        grants: 322500,
        revenue: null,
      },
      {
        description:
          "HUMANITARIAN AID PROVIDED THROUGH A CHILDRENS HOME, HOUSING PROJECTS FOR SLUM RESIDENTS, AND THE DISTRIBUTION OF AID AND CHRISTMAS GIFTS TO CHILDREN AND THOSE IN NEED.",
        expense: 258500,
        grants: 258500,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202202589349300145",
    returnVersion: "2019v5.2",
    ein: "593633323",
    taxYear: 2019,
    mission: "TO PROVIDE EARLY CHILDHOOD DEVELOPMENT AND EDUCATION.",
    website: "HTTPS://FLORIDACHILDREN.ORG/",
    totalRevenue: 4843669,
    totalExpenses: 4846656,
    totalAssetsEoy: 5688655,
    programs: [
      {
        description:
          "TO PROVIDE EARLY CHILDHOOD EDUCATIONAL ENRICHMENT AND SOCIAL STIMULATION TO CHILDREN BETWEEN THE AGES OF 3 & 5 BASED ON FAMILY INCOME GUIDELINES SET BY THE US DEPT OF HEALTH ADMIN OF CHILDREN, YOUTH & FAMILIES.",
        expense: 3547395,
        grants: null,
        revenue: null,
      },
      {
        description: "HIPPY PROGRAM",
        expense: 312069,
        grants: null,
        revenue: null,
      },
      {
        description:
          "TO PROVIDE CHILD CARE TO CHILDREN ENROLLED IN ABOVE PROGRAM.",
        expense: 169133,
        grants: null,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202242579349301334",
    returnVersion: "2020v4.0",
    ein: "112452456",
    taxYear: 2020,
    mission: "FIRE FIGHTING AND RESCUE",
    website: "WWW.CENTEREACHFD.ORG",
    totalRevenue: 233194,
    totalExpenses: 132554,
    totalAssetsEoy: 378466,
    programs: [
      {
        description:
          "COMMUNITY ACTIVITIES HOLIDAY PARTIES FOR CHILDREN, COMMUNITY PICNICS,SPORTS AND ACTIVITIES, FIRE PREVENTION EDUCATION, ASSISTANCE TO NEEDY.",
        expense: 68911,
        grants: null,
        revenue: null,
      },
      {
        description: "SUPPLYING EQUIPMENT AND SUPPLIES TO FIREFIGHTERS",
        expense: 63284,
        grants: null,
        revenue: null,
      },
      {
        description: "THIS IS FOR LEGAL FEES PAID DURING THE FISCAL YEAR.",
        expense: 359,
        grants: null,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202212579349302081",
    returnVersion: "2020v4.1",
    ein: "920085097",
    taxYear: 2020,
    mission:
      "Dedicated to the preservation of Alaska s prehistoric and historic resources through education, promotion and advocacy.",
    website: "WWW.ALASKAPRESERVATION.ORG",
    totalRevenue: 79813,
    totalExpenses: 108475,
    totalAssetsEoy: 199983,
    programs: [
      {
        description:
          "Oscar Anderson House Museum preservation of the first permanent struction built in Anchorage. Tours are provided to educate people about the lives of the settlers who helped build Anchorage.",
        expense: 2599,
        grants: 10000,
        revenue: 64,
      },
      {
        description:
          "Friends of Nike Site Summit provides administrative support and grant assistance to group restoring several buildings at Cold War Nike site. Public tours are part of this agreement.",
        expense: 924,
        grants: null,
        revenue: 4245,
      },
      {
        description:
          "Ten Most Endagered raises funds to help restore the top 10 historic sites in Alaska that are endangered of disappearing due to fatigue, erosion, etc.",
        expense: 310,
        grants: null,
        revenue: 2386,
      },
    ],
  },
  {
    objectId: "202232559349300838",
    returnVersion: "2020v4.2",
    ein: "237198658",
    taxYear: 2020,
    mission: "AID AND ASSISTANCE TO OUR INDIGENT / DISABLED MEMBERS",
    website: null,
    totalRevenue: 103113,
    totalExpenses: 22765,
    totalAssetsEoy: 2481008,
    programs: [
      {
        description:
          "DEATH RELATED EXPENSES- PAYMENTS TO WIDOW/ FAMILY OF MEMBER (ACTIVE OR DUES PAYING INACTIVE MEMBER) TO OFFSET SOME OR ALL OF THEIR FUNERAL EXPENSES.",
        expense: 8240,
        grants: 0,
        revenue: 0,
      },
      {
        description:
          "GOOD AND WELFARE- PAYMENTS OF MEDICAL AND FAMILY BILLS - MORTGAGE, HEAT, LOANS, ETC. (BASED UPON A COMMITTEE REVIEW FOR NEED) TO SICK AND INDIGENT ACTIVE MEMBERS, INACTIVE MEMBERS OR WIDOWS.",
        expense: 0,
        grants: 0,
        revenue: 0,
      },
      {
        description:
          "HOSPITAL STAY- PAYMENTS TO MEMBER ( ACTIVE OR INACTIVE) TO OFFSET ADDITIONAL EXPENSES WHILE HOSPITALIZED.",
        expense: 0,
        grants: 0,
        revenue: 0,
      },
    ],
  },
  {
    objectId: "202242579349301104",
    returnVersion: "2021v4.0",
    ein: "237431103",
    taxYear: 2021,
    mission:
      "PROVIDE HOUSING FOR UNDERGRADUATE CHAPTER OF NATIONAL COLLEGIATE SOCIAL FRATERNITY.",
    website: null,
    totalRevenue: 375333,
    totalExpenses: 177965,
    totalAssetsEoy: 1446290,
    programs: [
      {
        description:
          "PROVIDE GUIDANCE FOR MEMBERS OF UNDERGRADUATE CHAPTER OF NATIONAL COLLEGIATE SOCIAL FRATERNITY.",
        expense: null,
        grants: null,
        revenue: null,
      },
      {
        description:
          "PROVIDED OPPORTUNITY FOR ALUMNI MEMBERS TO INTERACT WITH UNDERGRADUATE MEMBERS OF CHAPTER.",
        expense: null,
        grants: null,
        revenue: null,
      },
      {
        description:
          "PROVIDED OPPORTUNITY FOR ALUMNI MEMBERS TO INTERACT WITH UNDERGRADUATE MEMBERS OF CHAPTER.",
        expense: null,
        grants: null,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202442299349300049",
    returnVersion: "2021v4.1",
    ein: "471777957",
    taxYear: 2021,
    mission:
      "Advocate, educate, support, and empower special needs people families, refugees, and anyone else lacking in someway or another",
    website: "www.eagleflightsa.com",
    totalRevenue: 466865,
    totalExpenses: 334783,
    totalAssetsEoy: 422911,
    programs: [
      {
        description: "Kym's Kloset",
        expense: 105718,
        grants: null,
        revenue: null,
      },
      {
        description: "Allen Hacienda",
        expense: 19243,
        grants: null,
        revenue: null,
      },
      { description: "Edgewood", expense: 11388, grants: null, revenue: null },
    ],
  },
  {
    objectId: "202443529349300414",
    returnVersion: "2021v4.2",
    ein: "884095736",
    taxYear: 2021,
    mission: "TO SUPPORT AND PROMOTE BASEBALL ATHLETES IN SONOMA COUNTY.",
    website: null,
    totalRevenue: 0,
    totalExpenses: 0,
    totalAssetsEoy: 0,
    programs: [
      { description: null, expense: 0, grants: 0, revenue: 0 },
      { description: null, expense: 0, grants: 0, revenue: 0 },
      { description: null, expense: 0, grants: 0, revenue: 0 },
    ],
  },
  {
    objectId: "202431369349308428",
    returnVersion: "2022v5.0",
    ein: "470269340",
    taxYear: 2022,
    mission:
      "PROVIDE AN EDUCATIONAL LIVING ENVIRONMENT FOR DEVELOPING MEN OF CHARACTER WITHIN THE ACADEMIC SETTING, WITH THE AIM THEY WILL BECOME FULLY CONTRIBUTING MEMBERS OF SOCIETY.",
    website: null,
    totalRevenue: 8,
    totalExpenses: 62083,
    totalAssetsEoy: 3031,
    programs: [
      {
        description:
          "PROVIDE RECURITING AND SOCIAL EVENTS TO PROMOTE THE FRATERNITY AND PROVIDE EXPERIENCES FOR MEMBERS.",
        expense: 6880,
        grants: null,
        revenue: null,
      },
      {
        description:
          "PROVIDE HOUSING THAT PROMOTES AN EDUCATIONAL ENVIRONMENT.",
        expense: null,
        grants: null,
        revenue: null,
      },
      {
        description: "PROVIDE FINANCIAL SUPPORT FOR MEMBERS.",
        expense: null,
        grants: null,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202420749349302007",
    returnVersion: "2023v4.0",
    ein: "920630139",
    taxYear: 2023,
    mission:
      "PROVIDE EDUCATION RESOURCES TO THE VIETNAMESE AMERICAN POPULATION",
    website: null,
    totalRevenue: 45000,
    totalExpenses: 10500,
    totalAssetsEoy: 34500,
    programs: [
      {
        description:
          "DONATIONS RECEIVED FROM NON-MEMBER AS A RESULT OF PROVIDING EDUCATION REGARDING THEIR VOTING POWER AND REVIVAL OF COMMUNITY'S FAITH IN ANTI-COMMUNISM AND DEMOCRACY.",
        expense: 10500,
        grants: 0,
        revenue: 45000,
      },
      { description: null, expense: 0, grants: 0, revenue: 0 },
      { description: null, expense: 0, grants: 0, revenue: 0 },
    ],
  },
  {
    objectId: "202433169349300518",
    returnVersion: "2023v5.0",
    ein: "262577931",
    taxYear: 2023,
    mission:
      'THE PURPOSE OF THIS ASSOCIATION SHALL BE TO MAINTAIN, REPAIR AND REPLACE THE COMMON ROAD, ITS BRIDGES, UNDER-ROAD CULVERTS AND PIPES, THE "CEDAR HILLS" ENTRY SIGNAGE AND MAILBOX COVER, AS NEEDED.',
    website: null,
    totalRevenue: 18,
    totalExpenses: 1200,
    totalAssetsEoy: 3426,
    programs: [
      {
        description: "SNOWPLOWING EXPENSES",
        expense: 550,
        grants: null,
        revenue: null,
      },
      {
        description: "CT ANNUAL REPORT",
        expense: 50,
        grants: null,
        revenue: null,
      },
      {
        description: "LICENSES, PERMITS AND FEES",
        expense: 50,
        grants: null,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202423179349308767",
    returnVersion: "2023v5.1",
    ein: "850965730",
    taxYear: 2023,
    mission:
      "TO TEACH AND EDUCATION THE COMMUNITY ON HEALTH DEVELOPMENT AND PROMOTING GOOD HEALTH",
    website: null,
    totalRevenue: 94744,
    totalExpenses: 241572,
    totalAssetsEoy: 0,
    programs: [
      {
        description:
          "COMMUNITY EVENT EDUCATING,TEACHING & HEALTH DEVELOPMENT INCLUDING MENTAL AND EMOTIONAL SUPPORT; AND OUTREACH",
        expense: 95965,
        grants: 39503,
        revenue: 0,
      },
      {
        description:
          "OUTREACH PROGRAM HEALTH DEVELOPMENT MENTAL AND EMOTIONAL SUPPORT",
        expense: 49985,
        grants: 35797,
        revenue: 0,
      },
      {
        description: "BRING THE COMMUNITY TOGETHER THROUGH HEALING",
        expense: 28012,
        grants: 19444,
        revenue: 0,
      },
    ],
  },
  {
    objectId: "202610909349300811",
    returnVersion: "2025v4.0",
    ein: "274639056",
    taxYear: 2025,
    mission:
      "STUDENTS FIRST CORP ENDEAVORS TO IMPROVE THE EDUCATION SYSTEM AT THE PRE-KINDERGARTEN THROUGH HIGH SCHOOL LEVELS BY RESTRUCTURING EDUCATIONAL INSTITUTIONS AND EXPANDING PARENTS' OPTIONS IN THE SCHOOLS AVAILABLE TO THEIR CHILDREN.",
    website: null,
    totalRevenue: 0,
    totalExpenses: 6360,
    totalAssetsEoy: 14547,
    programs: [
      { description: null, expense: 0, grants: null, revenue: null },
      { description: null, expense: 0, grants: null, revenue: null },
      { description: null, expense: 0, grants: null, revenue: null },
    ],
  },
  {
    objectId: "202611759349301206",
    returnVersion: "2025v4.2",
    ein: "861426056",
    taxYear: 2025,
    mission:
      "LABOR UNION, REPRESENT MEMBERS WITH ALL LABOR ISSUES AND ORGANIZE WORKERS",
    website: null,
    totalRevenue: 241170,
    totalExpenses: 263793,
    totalAssetsEoy: 29368,
    programs: [
      {
        description: "LABOR UNION",
        expense: 263793,
        grants: null,
        revenue: null,
      },
      {
        description: "REPRESENT WORKERS WITH LABOR ISSUES",
        expense: null,
        grants: null,
        revenue: null,
      },
      {
        description: "ORGANIZE WORKERS",
        expense: null,
        grants: null,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202621339349306127",
    returnVersion: "2024v5.4",
    ein: "680471501",
    taxYear: 2024,
    mission:
      "The purpose of this organization is to fund health and welfare benefits offered to retired employees of the Clorox Company and its participating subsidiaries. Employer and employee contributions made to the organization are exempt from taxation per IRS Department Letter dated 3/18/2002.",
    website: null,
    totalRevenue: 2113104,
    totalExpenses: 2913589,
    totalAssetsEoy: 881387,
    programs: [
      {
        description:
          'The Clorox Company Voluntary Employees Beneficiary Association ("VEBA Trust") was established for the purpose of providing security to active employees by holding employer funds contributed by Clorox and its subsidiaries and by employees for the payment of medical, dental, and vision benefits. On January 1, 2002, the trust agreement dated September 28, 2000 between The Clorox Company and Union Bank of California, N.A. (Trustee) was amended to add The Clorox Company Group Insurance Plan for Certain Retired and Disabled Participants (Plan No. 508) to the trust. On June 24, 2008, the VEBA Trust Agreement was amended to remove the current eligible employees from the VEBA Trust. Effective July 1, 2008 active employee contributions are no longer held in the VEBA Trust and certain benefits and expenses for the active employees are paid through the general assets of the Clorox Company. Effective July 1, 2018, The Clorox Company Group Insurance Plan for Retirees was established to provide benefits for eligible former employees of The Clorox Company.',
        expense: null,
        grants: null,
        revenue: null,
      },
    ],
  },
])("a $returnVersion Form 990 ($objectId)", ({ objectId, ...expected }) => {
  test("yields its mission, website, finances and top programs", async () => {
    const { activitySummary: _, ...parsed } = await parseFixture(objectId);
    expect(parsed).toEqual({ formType: "990", ...expected });
  });
});

describe("a Form 990 whose elements carry a namespace prefix (irs:Return)", () => {
  test("yields the same fields as an unprefixed one", async () => {
    expect(await parseFixture("202601499349300130")).toEqual({
      returnVersion: "2025v4.1",
      formType: "990",
      ein: "992834231",
      taxYear: 2025,
      mission:
        "become the change in order to outreach in love. We will reach & impact various communities providing tangible and intangible resources for people through education and sports training,",
      activitySummary:
        "become the change in order to outreach in love. We will reach, teach & impact various communities providing tangible and intangible resources",
      website: null,
      totalRevenue: 249_101,
      totalExpenses: 206_337,
      totalAssetsEoy: 0,
      programs: [
        {
          description:
            "GYM FEES: $126,000 BRANDED APPAREL & EQUIPMENT: $60,000 ACADEMIC CURRICULUM: $41,000 SALARIES: $266,000 VANS/FOOD/HOTEL/VEHICLE FUEL/FLIGHTS: $140,800 UTILITIES: $9,782 TOLL FEES: 1,000 FURNITURE: $48,000 PLAYER & PARENT TUITION FEES: $75,625 OFFICE EXPENSE: $2,100 GARDNER: $500",
          expense: null,
          grants: null,
          revenue: null,
        },
      ],
    });
  });
});

describe("a 990-PF", () => {
  test("yields only its header facts until the 990-PF parser lands", async () => {
    expect(await parseFixture("202630729349100528")).toEqual({
      returnVersion: "2024v5.2",
      formType: "990-PF",
      ein: "934054155",
      taxYear: 2024,
      mission: null,
      activitySummary: null,
      website: null,
      totalRevenue: null,
      totalExpenses: null,
      totalAssetsEoy: null,
      programs: [],
    });
  });
});

describe("a return breaking the layout", () => {
  test("with a cents amount throws naming the element", async () => {
    const xml = (
      await readFile(new URL("202640829349300109_public.xml", XML), "utf8")
    ).replace(
      "<CYTotalRevenueAmt>3916983933<",
      "<CYTotalRevenueAmt>3916983933.25<",
    );
    await expect(
      parseReturn(Readable.from([Buffer.from(xml)])),
    ).rejects.toThrow(
      'CYTotalRevenueAmt is "3916983933.25", expected a whole-dollar amount',
    );
  });

  test("cut off before its form ends throws", async () => {
    const xml = await readFile(new URL("202640829349300109_public.xml", XML));
    await expect(
      parseReturn(
        Readable.from([xml.subarray(0, xml.indexOf("<MissionDesc>"))]),
      ),
    ).rejects.toThrow("the return ends without an IRS990 form");
  });
});
