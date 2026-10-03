import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { parseReturn, RejectedReturn } from "./efile-xml.ts";

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
    // its three program groups are empty placeholders
    programs: [],
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
    programs: [],
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
    expect(parsed).toEqual({
      formType: "990",
      missionOnScheduleO: false,
      ...expected,
    });
  });
});

describe("a Form 990 whose elements carry a namespace prefix (irs:Return)", () => {
  test("yields the same fields as an unprefixed one", async () => {
    expect(await parseFixture("202601499349300130")).toEqual({
      missionOnScheduleO: false,
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

describe("a 990-EZ", () => {
  test("yields its primary exempt purpose as mission, its website, finances and top programs by expense", async () => {
    expect(await parseFixture("202630139349200908")).toEqual({
      missionOnScheduleO: false,
      returnVersion: "2024v5.0",
      formType: "990-EZ",
      ein: "316050644",
      taxYear: 2024,
      mission: "Assist statewide youth through optimism and public service",
      activitySummary: null,
      website: "ohiodistrictoptimist.org",
      totalRevenue: 81_241,
      totalExpenses: 92_012,
      totalAssetsEoy: 39_111,
      // the third of its four programs states the least expense
      programs: [
        [
          48_765,
          "Provide training to members including youth members on optimism and how to help youth gain confidence and experience in working to assist others",
        ],
        [
          23_603,
          "Assist Junior Optimists members (Elementary through High School Students) hold their annual statewide and international convention",
        ],
        [
          15_827,
          "Hold a statewide Optimists International Junior Golf Championship qualifying tournament and provide entry fees for qualifying golfers and chaperone travel reimbursements to the International Championship Tournament.",
        ],
      ].map(([expense, description]) => ({
        description,
        expense,
        grants: 0,
        revenue: null,
      })),
    });
  });
});

describe("a 990-PF", () => {
  test("yields its website and book-value finances, and no mission or programs", async () => {
    expect(await parseFixture("202630139349100013")).toEqual({
      missionOnScheduleO: false,
      returnVersion: "2023v6.0",
      formType: "990-PF",
      ein: "920372947",
      taxYear: 2023,
      mission: null,
      activitySummary: null,
      website: "https://www.flipcause.com/secure/cause_pdetai",
      totalRevenue: 4_136,
      totalExpenses: 7_856,
      // Part II line 16 column (b); its fair market value, column (c), is 6,728
      totalAssetsEoy: 7_478,
      programs: [],
    });
  });
});

/**
 * One real 990-EZ per returnVersion seen in the 2024–2026 batches; expected
 * values read off each file with ElementTree, independently of this parser.
 */
describe.each([
  {
    objectId: "202212589349200831",
    returnVersion: "2019v5.0",
    ein: "205633190",
    taxYear: 2019,
    mission:
      "Empowering women and children in underserved communities through fundraising volunteerism and outreach",
    website: "wgirls.org",
    totalRevenue: 174_957,
    totalExpenses: 164_184,
    totalAssetsEoy: 422_272,
    programs: [
      { description: "0", expense: null, grants: null, revenue: null },
    ],
  },
  {
    objectId: "202222529349200147",
    returnVersion: "2019v5.1",
    ein: "223561331",
    taxYear: 2019,
    mission:
      "As a PTO to Improve relationship between parents, teachers, and students",
    website: "ppbhs-pointpsd.enschool.org",
    totalRevenue: 2820,
    totalExpenses: 5538,
    totalAssetsEoy: 3842,
    programs: [
      {
        description:
          "Scholarships and awards for graduating high school students",
        expense: 3350,
        grants: null,
        revenue: null,
      },
      {
        description:
          "Provide financial assistance and support to high school grade and class activities. The school has approximately 1000 school children in grades 9 through 12.",
        expense: 1284,
        grants: null,
        revenue: null,
      },
      {
        description:
          "Provide reimbursment and appreciation for teacher projects and expenses. The school usually has approximately 50 classroom teachers and many other special programs",
        expense: 532,
        grants: null,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202202569349201150",
    returnVersion: "2019v5.2",
    ein: "824907354",
    taxYear: 2019,
    mission:
      "THE FOUNDATION WAS ESTABLISHED WITH THE MISSION OF AIDING AND SUPPORTING FAMILIES FACING DIPG DIAGNOSIS BY PROVIDING RESOURCES AND FINANCIAL GRANTS TO GIVE EVERY CHILD FACING DIPG A FIGHTING CHANCE.",
    website: "WWW.WHYNOTDEVINFOUNDATION.ORG",
    totalRevenue: 54_572,
    totalExpenses: 3481,
    totalAssetsEoy: 99_301,
    programs: [
      {
        description:
          "THE ORGANIZATION PROVIDES FUND TO FAMILIES OF DIPG PATIENTS AND PATIENTS WITH OTHER FORMS OF PEDIACTRIC CANCER.",
        expense: 0,
        grants: 0,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202202559349200225",
    returnVersion: "2020v4.0",
    ein: "134291032",
    taxYear: 2020,
    mission: "To provide community Fastpitch Softball to youth girls",
    website: "www.edinafastpitch.org",
    totalRevenue: 113_913,
    totalExpenses: 103_028,
    totalAssetsEoy: 46_487,
    programs: [
      {
        description: "Paid coaches and training, umpires and facilities rental",
        expense: 52_436,
        grants: 0,
        revenue: null,
      },
      {
        description:
          "equipment, summer and fall league expenses - league fees, tournament fees, uniforms, field fees",
        expense: 38_465,
        grants: 0,
        revenue: null,
      },
      {
        description:
          "bank fees, liability insurance, misc board expenses and donations",
        expense: 9678,
        grants: 0,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202343569349200609",
    returnVersion: "2020v4.1",
    ein: "010957670",
    taxYear: 2020,
    mission: "To raise money for local charities",
    website: "http://granburywinewalk.com/",
    totalRevenue: 27_818,
    totalExpenses: 89_109,
    totalAssetsEoy: 0,
    programs: [
      {
        description:
          "Held an annual event featuring local businesses. The proceeds of the event go to designated charities in Hood County.",
        expense: 28_646,
        grants: 54_550,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202202529349200535",
    returnVersion: "2020v4.2",
    ein: "710393164",
    taxYear: 2020,
    mission: "AGRICULTURAL PROMOTION",
    website: "WWW.ARFB.COM/MARION",
    totalRevenue: 100_100,
    totalExpenses: 89_167,
    totalAssetsEoy: 134_455,
    programs: [
      {
        description:
          "COUNTY FARM BUREAU WORK IS GENERAL IN NATURE, HELPING FARM FAMILIES ACHIEVE EDUCATIONAL IMPROVEMENTS, ECONOMIC OPPORTUNITY, AND SOCIAL ADVANCEMENT.",
        expense: 0,
        grants: 0,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202313579349200601",
    returnVersion: "2021v4.0",
    ein: "470831276",
    taxYear: 2021,
    mission:
      "Funding abortion clients and patients to keep access to abortion available",
    website: "AbortionAccessFund.Org",
    totalRevenue: 131_310,
    totalExpenses: 103_357,
    totalAssetsEoy: 54_437,
    programs: [
      {
        description:
          "Grants to abortion clients paid to clinics on behalf of multiple funders.",
        expense: 0,
        grants: 103_034,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202400169349201125",
    returnVersion: "2021v4.1",
    ein: "473954055",
    taxYear: 2021,
    mission:
      "The 1619 Freedom School is a free community-based, after-school literacy program where students improve literacy skills and develop a love for reading through liberating instruction centered on Black American history.",
    website: "https://www.1619freedomschool.org/",
    totalRevenue: 18_235,
    totalExpenses: 33_885,
    totalAssetsEoy: 13_776,
    programs: [
      {
        description:
          "Launched free literacy program and was able to provide books to all students.",
        expense: 24_781,
        grants: null,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202313569349200311",
    returnVersion: "2021v4.2",
    ein: "611619371",
    taxYear: 2021,
    mission:
      "THE PRIMARY PURPOSE OF THIS ORGANIZATION (PARENT TEACHER COMMITTEE) IS TO PROMOTE COOPERATION, APPRECIATION AND UNDERSTANDING BETWEEN PARENTS, STAFF, AND STUDENTS OF LIBERTY ELEMENTARY SCHOOL; AND TO SUPPORT THE SCHOOL PROGRAM THROUGH THE SPONSORING OF FUNDRAISERS AND EVENTS. IN ACCORDANCE WITH THIS PURPOSE, THE PARENT TEACHER COMMITTEE STRIVES TO ESTABLISH A RELATIONSHIP THAT WILL SERVE THE CHILDREN, SCHOOL, PARENTS AND COMMUNITY.",
    website: "HTTPS://WWW.CVESD.ORG/SCHOOLS",
    totalRevenue: 126_999,
    totalExpenses: 116_178,
    totalAssetsEoy: 37_938,
    programs: [
      {
        description: "PLANNED EVENTS",
        expense: 34_401,
        grants: 0,
        revenue: null,
      },
      {
        description: "PROGRAMS & SPONSORSHIPS",
        expense: 30_059,
        grants: 30_059,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202303569349200015",
    returnVersion: "2022v5.0",
    ein: "471914654",
    taxYear: 2022,
    mission:
      "The Arc Rutherford County is committed to supporting and improving the quality of life for individuals with challenges through actions and programs promoting personal empowerment, community-wide inclusion, advocacy, public education and research.",
    website: "www.thearcrutherford.org",
    totalRevenue: 1575,
    totalExpenses: 1520,
    totalAssetsEoy: 2018,
    programs: [
      {
        description:
          "Provide information and resources provided to families and agencies to serve individuals with disabilities. Provide available resources to callers in Rutherford County.",
        expense: 0,
        grants: 0,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202400179349200500",
    returnVersion: "2023v4.0",
    ein: "832870471",
    taxYear: 2023,
    mission: "ASSIST THOSE WITH BARRIERS BIKE.",
    website: "WWW.THEBLESSINGBIKE.COM",
    totalRevenue: -32_330,
    totalExpenses: 26_707,
    totalAssetsEoy: 0,
    programs: [
      {
        description:
          "BUILT 30 BIKES FOR FAMILIES NURSING HOMES AND AGENCIES THAT WORK WITH AGE DISABILITIES OR HEALTH ISSUES",
        expense: 0,
        grants: 0,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202400779349200160",
    returnVersion: "2023v5.0",
    ein: "842381233",
    taxYear: 2023,
    mission:
      "Mount Liberty College is a 4-year classical liberal arts college helping students earn a great education to benefit them in all aspects of their future lives including, but not limited to, their careers.",
    website: "https://mountlibertycollege.org/",
    totalRevenue: 93_898,
    totalExpenses: 80_262,
    totalAssetsEoy: 93_416,
    programs: [
      {
        description:
          "Mount Liberty College was founded to educate our students in the classical liberal arts. We just completed our fourth year of classes and had an average of 25 students during this past year. Our students are earning a great education which will help them in any career path they choose to enter.",
        expense: 80_262,
        grants: 0,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202401699349200605",
    returnVersion: "2023v5.1",
    ein: "853222603",
    taxYear: 2023,
    mission:
      "TO ASSIST SENIORS IN THEIR DAY TO DAY NEEDS BY PROVIDING SERVICES, TRANSPORTATION, AND GENERAL ASSISTANCE.",
    website: "HTTPS://WWW.SEAGLASSVILLAGE.ORG",
    totalRevenue: 36_525,
    totalExpenses: 36_650,
    totalAssetsEoy: 24_811,
    programs: [
      {
        description:
          "PROVIDING SERVICES, TRANSPORTATION, AND GENERAL COMPANIONSHIP TO SENIORS TO HELP REDUCE THE RISKS THEY FACE IN DOING THESE ACTIVITIES ALONE.",
        expense: 36_650,
        grants: 0,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202500159349200015",
    returnVersion: "2023v6.0",
    ein: "232368401",
    taxYear: 2023,
    mission:
      "LEADERSHIP SUPPORT TO AFFILIATES WITHIN THE DISTRICT AND CARRIES COMMUNITY SERVICE PURPOSE OF ROTARY INTERNATIONAL",
    website: "WWW.ROTARY.ORG",
    totalRevenue: 123_259,
    totalExpenses: 128_085,
    totalAssetsEoy: 208_011,
    programs: [
      {
        description:
          "ROTARY INTERNATIONAL DISTRICT 7390 PROVIDES PROGRAMS TO PROMOTE COMMUNITY SERVICE IN THE COMMUNITY, WORKPLACE, AND THROUGHOUT THE WORLD.",
        expense: 118_124,
        grants: 4300,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202630139349200908",
    returnVersion: "2024v5.0",
    ein: "316050644",
    taxYear: 2024,
    mission: "Assist statewide youth through optimism and public service",
    website: "ohiodistrictoptimist.org",
    totalRevenue: 81_241,
    totalExpenses: 92_012,
    totalAssetsEoy: 39_111,
    programs: [
      {
        description:
          "Provide training to members including youth members on optimism and how to help youth gain confidence and experience in working to assist others",
        expense: 48_765,
        grants: 0,
        revenue: null,
      },
      {
        description:
          "Assist Junior Optimists members (Elementary through High School Students) hold their annual statewide and international convention",
        expense: 23_603,
        grants: 0,
        revenue: null,
      },
      {
        description:
          "Hold a statewide Optimists International Junior Golf Championship qualifying tournament and provide entry fees for qualifying golfers and chaperone travel reimbursements to the International Championship Tournament.",
        expense: 15_827,
        grants: 0,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202500839349200420",
    returnVersion: "2024v5.1",
    ein: "461720789",
    taxYear: 2024,
    mission:
      "AS THE PHILANTHROPIC BODY OF THE APARTMENT ASSOCIATION OF GREATER ORLANDO WE CHAMPION ENGAGEMENT, GIVING, AND SERVICE OPPORTUNITIES THAT SUPPORT OUR LOCAL CHARITY PARTNERS.",
    website: "WWW.AAGOFOUNDATION.ORG",
    totalRevenue: 86_650,
    totalExpenses: 67_375,
    totalAssetsEoy: 83_143,
    programs: [
      {
        description:
          "AS THE PHILANTHROPIC BODY OF THE APARTMENT ASSOCIATION OF GREATER ORLANDO WE CHAMPION ENGAGEMENT, GIVING, AND SERVICE OPPORTUNITIES THAT SUPPORT OUR LOCAL CHARITY PARTNERS.",
        expense: 41_474,
        grants: 43_425,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202501749349200125",
    returnVersion: "2024v5.2",
    ein: "651302496",
    taxYear: 2024,
    mission:
      "TO SERVICE THE LOCAL BUSINESS COMMUNITY IN THE CENTENNIAL VILLAGE AREA",
    website: "gotocentennialvillage.com",
    totalRevenue: 623,
    totalExpenses: 3679,
    totalAssetsEoy: 6633,
    programs: [
      {
        description: "LANDSCAPING FOR THE DOWNTOWN AREA",
        expense: 2659,
        grants: 0,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202601139349201505",
    returnVersion: "2024v5.4",
    ein: "134225061",
    taxYear: 2024,
    mission: "Sharing the world's great choral music",
    website: "www.plymouthfesticalchorus.org",
    totalRevenue: 73_945,
    totalExpenses: 71_246,
    totalAssetsEoy: 59_669,
    programs: [
      {
        description:
          "Scholarships awarded: $2000. Two major concerts/year + summer sings. Total audiences approx. 2500. Live classical singing not heard elsewhere in the region.",
        expense: null,
        grants: null,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202600139349200930",
    returnVersion: "2024v5.5",
    ein: "994509771",
    taxYear: 2024,
    mission:
      "VALOR TOGETHER IS A NON-PROFIT ORGANIZATION DEDICATED TO IMPROVING MENTAL HEALTH OUTCOMES FOR SCHOOL-AGED CHILDREN THROUGHOUT THE COMMONWEALTH OF MASSACHUSETTS.",
    website: "HTTPS://WWW.VALORTOGETHER.ORG/",
    totalRevenue: 33_103,
    totalExpenses: 11_242,
    totalAssetsEoy: 21_861,
    programs: [
      {
        description: "ART THERAPY PROGRAM",
        expense: 1162,
        grants: 6000,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202600139349200100",
    returnVersion: "2025v4.0",
    ein: "382909148",
    taxYear: 2025,
    mission: "COMMUNITY FOOD PANTRY",
    website: "www.helpinghandshc.org",
    totalRevenue: 92_780,
    totalExpenses: 63_660,
    totalAssetsEoy: 277_490,
    programs: [
      {
        description:
          "PROVIDED FOOD TO APPROXIMATELY 2,000NEEDY FAMILIES IN OUR COMMUNITY EACH YEAR",
        expense: 0,
        grants: null,
        revenue: null,
      },
    ],
  },
  {
    objectId: "202600899349201445",
    returnVersion: "2025v4.1",
    ein: "391497262",
    taxYear: 2025,
    mission: "YOUTH SOCCER EDUCATION",
    website: "WWW.DPRYS.ORG",
    totalRevenue: 148_559,
    totalExpenses: 128_243,
    totalAssetsEoy: 275_363,
    programs: [
      {
        description: "YOUTH SOCCER EDUCATION",
        expense: 0,
        grants: 0,
        revenue: null,
      },
      { description: "DRUG PREVENTION", expense: 0, grants: 0, revenue: null },
      { description: "SPORTSMANSHIP", expense: 0, grants: 0, revenue: null },
    ],
  },
  {
    objectId: "202601739349200690",
    returnVersion: "2025v4.2",
    ein: "800534025",
    taxYear: 2025,
    mission:
      "TOP PRODUCING REAL ESTATE PROFESSIONALS, COLLECTIVELY INSPIRING AND ENHANCING THE PIKES PEAK REGION BY GIVING BACK TO THE COMMUNITY.",
    website: "WWW.THEPEAKPRODUCERS.COM",
    totalRevenue: 77_445,
    totalExpenses: 92_660,
    totalAssetsEoy: 16_233,
    programs: [
      {
        description:
          "PEAK PRODUCER HOSTS EVENTS WITH SPEAKERS TO DISCUSS INSPIRING AND ENHANCING THE PIKES PEAK REGION BY GIVING BACK TO THE COMMUNITY.",
        expense: 20_987,
        grants: 0,
        revenue: null,
      },
    ],
  },
])("a $returnVersion 990-EZ ($objectId)", ({ objectId, ...expected }) => {
  test("yields its mission, website, finances and top programs", async () => {
    expect(await parseFixture(objectId)).toEqual({
      formType: "990-EZ",
      missionOnScheduleO: false,
      activitySummary: null,
      ...expected,
    });
  });
});

/** One real 990-PF per returnVersion, read the same way. */
describe.each([
  {
    objectId: "202212589349100616",
    returnVersion: "2019v5.0",
    ein: "473854796",
    taxYear: 2019,
    totalRevenue: 14_710,
    totalExpenses: 18_386,
    totalAssetsEoy: 496,
  },
  {
    objectId: "202202569349100505",
    returnVersion: "2019v5.1",
    ein: "521288017",
    taxYear: 2019,
    totalRevenue: 22_000,
    totalExpenses: 7500,
    totalAssetsEoy: 0,
  },
  {
    objectId: "202202589349101505",
    returnVersion: "2019v5.2",
    ein: "811684715",
    taxYear: 2019,
    totalRevenue: 1_443_972,
    totalExpenses: 100_080,
    totalAssetsEoy: 1_341_238,
  },
  {
    objectId: "202202529349100320",
    returnVersion: "2020v4.0",
    ein: "814772264",
    taxYear: 2020,
    totalRevenue: 43_368,
    totalExpenses: 172_262,
    totalAssetsEoy: 2_929_559,
  },
  {
    objectId: "202202559349100015",
    returnVersion: "2020v4.1",
    ein: "472317556",
    taxYear: 2020,
    totalRevenue: 8258,
    totalExpenses: 14_106,
    totalAssetsEoy: 513_575,
  },
  {
    objectId: "202202529349100005",
    returnVersion: "2020v4.2",
    ein: "262665440",
    taxYear: 2020,
    totalRevenue: 10_001,
    totalExpenses: 20_520,
    totalAssetsEoy: 291_670,
  },
  {
    objectId: "202400189349100205",
    returnVersion: "2021v4.0",
    ein: "341731179",
    taxYear: 2021,
    totalRevenue: 14_690,
    totalExpenses: 24_455,
    totalAssetsEoy: 520_542,
  },
  {
    objectId: "202400169349101160",
    returnVersion: "2021v4.1",
    ein: "844210848",
    taxYear: 2021,
    website: "www.milkfoundation.org",
    totalRevenue: 373_576,
    totalExpenses: 291_132,
    totalAssetsEoy: 334_012,
  },
  {
    objectId: "202400169349100065",
    returnVersion: "2021v4.2",
    ein: "843145664",
    taxYear: 2021,
    totalRevenue: 269_461,
    totalExpenses: 29_054,
    totalAssetsEoy: 993_778,
  },
  {
    objectId: "202303569349100400",
    returnVersion: "2022v5.0",
    ein: "300094637",
    taxYear: 2022,
    totalRevenue: 71_285,
    totalExpenses: 89_058,
    totalAssetsEoy: 871_029,
  },
  {
    objectId: "202400179349100300",
    returnVersion: "2023v4.0",
    ein: "474486721",
    taxYear: 2023,
    totalRevenue: 791,
    totalExpenses: 732,
    totalAssetsEoy: 59,
  },
  {
    objectId: "202400779349100150",
    returnVersion: "2023v5.0",
    ein: "862915182",
    taxYear: 2023,
    totalRevenue: 7592,
    totalExpenses: 5335,
    totalAssetsEoy: 6207,
  },
  {
    objectId: "202401699349100000",
    returnVersion: "2023v5.1",
    ein: "911459949",
    taxYear: 2023,
    totalRevenue: 884_711,
    totalExpenses: 922_658,
    totalAssetsEoy: 207_473,
  },
  {
    objectId: "202630139349100013",
    returnVersion: "2023v6.0",
    ein: "920372947",
    taxYear: 2023,
    website: "https://www.flipcause.com/secure/cause_pdetai",
    totalRevenue: 4136,
    totalExpenses: 7856,
    totalAssetsEoy: 7478,
  },
  {
    objectId: "202500209349100110",
    returnVersion: "2024v5.0",
    ein: "844769920",
    taxYear: 2024,
    totalRevenue: 6856,
    totalExpenses: 6787,
    totalAssetsEoy: 0,
  },
  {
    objectId: "202500829349100005",
    returnVersion: "2024v5.1",
    ein: "993040881",
    taxYear: 2024,
    totalRevenue: 52_751,
    totalExpenses: 936,
    totalAssetsEoy: 52_251,
  },
  {
    objectId: "202630729349100528",
    returnVersion: "2024v5.2",
    ein: "934054155",
    taxYear: 2024,
    totalRevenue: 0,
    totalExpenses: 0,
    totalAssetsEoy: 0,
  },
  {
    objectId: "202600139349100005",
    returnVersion: "2024v5.5",
    ein: "383354189",
    taxYear: 2024,
    totalRevenue: 627_179,
    totalExpenses: 269_688,
    totalAssetsEoy: 3_078_129,
  },
  {
    objectId: "202600139349100200",
    returnVersion: "2025v4.0",
    ein: "873310310",
    taxYear: 2025,
    totalRevenue: 5794,
    totalExpenses: 240,
    totalAssetsEoy: 5848,
  },
  {
    objectId: "202600899349100015",
    returnVersion: "2025v4.1",
    ein: "274826335",
    taxYear: 2025,
    totalRevenue: 9_885_473,
    totalExpenses: 16_735_278,
    totalAssetsEoy: 25_749_654,
  },
  {
    objectId: "202601739349100050",
    returnVersion: "2025v4.2",
    ein: "364442342",
    taxYear: 2025,
    totalRevenue: 544_066,
    totalExpenses: 333_753,
    totalAssetsEoy: 5_165_072,
  },
])("a $returnVersion 990-PF ($objectId)", ({ objectId, ...expected }) => {
  test("yields its website, when it reads as one, and finances", async () => {
    expect(await parseFixture(objectId)).toEqual({
      formType: "990-PF",
      missionOnScheduleO: false,
      mission: null,
      activitySummary: null,
      website: null,
      programs: [],
      ...expected,
    });
  });
});

/** The fixture return `objectId` with `from` replaced by `to`, as one chunk. */
async function fixtureWith(
  objectId: string,
  from: string,
  to: string,
): Promise<Readable> {
  const xml = await readFile(new URL(`${objectId}_public.xml`, XML), "utf8");
  if (!xml.includes(from)) throw new Error(`fixture lacks ${from}`);
  return Readable.from([Buffer.from(xml.replace(from, to))]);
}

/** The Red Cross 990 with `from` replaced by `to`, as one chunk. */
function redCrossWith(from: string, to: string): Promise<Readable> {
  return fixtureWith("202640829349300109", from, to);
}

describe("a return rejected on its own, leaving the run going", () => {
  test.each([
    {
      reason: "bad amount",
      from: "<CYTotalRevenueAmt>3916983933<",
      to: "<CYTotalRevenueAmt>3916983933.25<",
      message:
        'CYTotalRevenueAmt is "3916983933.25", expected a whole-dollar amount',
    },
    {
      reason: "bad TaxYr",
      from: "<TaxYr>2024<",
      to: "<TaxYr>FY24<",
      message: 'TaxYr is "FY24"',
    },
    {
      reason: "form type mismatch",
      from: "<ReturnTypeCd>990<",
      to: "<ReturnTypeCd>990T<",
      message: 'ReturnTypeCd is "990T"',
    },
    {
      reason: "EIN mismatch",
      from: "<EIN>530196605<",
      to: "<EIN>53019660<",
      message: 'Filer EIN is "53019660"',
    },
  ])("has a $reason", async ({ reason, from, to, message }) => {
    const rejected = await parseReturn(await redCrossWith(from, to)).catch(
      (error: unknown) => error,
    );
    expect(rejected).toBeInstanceOf(RejectedReturn);
    expect(rejected).toMatchObject({
      reason,
      returnVersion: "2024v5.1",
      message,
    });
  });
});

describe("a mission that only points to Schedule O", () => {
  test("is stored as null and flagged in a real 990-EZ", async () => {
    expect(await parseFixture("202640199349200804")).toMatchObject({
      returnVersion: "2024v5.0",
      formType: "990-EZ",
      ein: "310899051",
      mission: null,
      missionOnScheduleO: true,
    });
  });

  // the variants seen among the 990 missions of 2026_TEOS_XML_03A
  test.each([
    "SEE SCHEDULE O",
    "SEE SCHEDULE O.",
    "See Schedule O",
    "PLEASE SEE SCHEDULE O",
    "SEE SCH O",
    "SEE SCHEDULE O FOR DETAILS.",
    "SEE SCHEDULE O, STATEMENT 1",
    "SEE SCHEDULE O FORM 990, PART I, LINE 1",
    "SEE MISSION STATEMENT ON SCHEDULE O.",
    "CONTINUED IN SCHEDULE O",
    "MISSION STATEMENT IS OUTLINED IN SCHEDULE O.",
  ])("is stored as null: %s", async (pointer) => {
    const parsed = await parseReturn(
      await redCrossWith(
        `<MissionDesc>${RED_CROSS_MISSION}<`,
        `<MissionDesc>${pointer}<`,
      ),
    );
    expect(parsed).toMatchObject({ mission: null, missionOnScheduleO: true });
  });

  test("is stored as null when a 990-EZ's primary exempt purpose", async () => {
    const parsed = await parseReturn(
      await fixtureWith(
        "202630139349200908",
        "<PrimaryExemptPurposeTxt>Assist statewide youth through optimism and public service<",
        "<PrimaryExemptPurposeTxt>SEE SCHEDULE O<",
      ),
    );
    expect(parsed).toMatchObject({
      formType: "990-EZ",
      mission: null,
      missionOnScheduleO: true,
    });
  });

  test.each([
    "EARLY CHILDHOOD EDUCATION - SEE SCHEDULE O.",
    "TO PROVIDE EXCEPTIONAL HEALTHCARE. SEE SCHEDULE O FOR ADDITIONAL INFORMATION.",
  ])("is kept when it states a mission first: %s", async (mission) => {
    const parsed = await parseReturn(
      await redCrossWith(
        `<MissionDesc>${RED_CROSS_MISSION}<`,
        `<MissionDesc>${mission}<`,
      ),
    );
    expect(parsed).toMatchObject({ mission, missionOnScheduleO: false });
  });
});

describe("a placeholder program, with no description and no amount but 0", () => {
  const FRATERNITY = "202431369349308428";
  const LAST_GROUP = "</ProgSrvcAccomActy3Grp>";
  const withGroup = async (amounts: string) =>
    (
      await parseReturn(
        await fixtureWith(
          FRATERNITY,
          LAST_GROUP,
          `${LAST_GROUP}<ProgSrvcAccomActyOtherGrp>${amounts}</ProgSrvcAccomActyOtherGrp>`,
        ),
      )
    ).programs.map((p) => p.description ?? p);

  test("is dropped before ranking, not ranked above described programs stating no expense", async () => {
    expect(
      await withGroup(
        "<ExpenseAmt>0</ExpenseAmt><GrantAmt>0</GrantAmt><RevenueAmt>0</RevenueAmt>",
      ),
    ).toEqual([
      "PROVIDE RECURITING AND SOCIAL EVENTS TO PROMOTE THE FRATERNITY AND PROVIDE EXPERIENCES FOR MEMBERS.",
      "PROVIDE HOUSING THAT PROMOTES AN EDUCATIONAL ENVIRONMENT.",
      "PROVIDE FINANCIAL SUPPORT FOR MEMBERS.",
    ]);
  });

  test("is kept when it states a non-zero amount", async () => {
    expect(
      await withGroup("<ExpenseAmt>0</ExpenseAmt><GrantAmt>500</GrantAmt>"),
    ).toEqual([
      "PROVIDE RECURITING AND SOCIAL EVENTS TO PROMOTE THE FRATERNITY AND PROVIDE EXPERIENCES FOR MEMBERS.",
      { description: null, expense: 0, grants: 500, revenue: null },
      "PROVIDE HOUSING THAT PROMOTES AN EDUCATIONAL ENVIRONMENT.",
    ]);
  });
});

describe("an activity summary that only points to Schedule O", () => {
  test.each([
    "SEE SCHEDULE O",
    "SEE SCHEDULE O.",
    "PLEASE SEE SCHEDULE O",
    "SEE SCHEDULE O FORM 990, PART I, LINE 1",
  ])("is stored as null, leaving the mission: %s", async (pointer) => {
    const parsed = await parseReturn(
      await redCrossWith(
        `<ActivityOrMissionDesc>${RED_CROSS_MISSION}<`,
        `<ActivityOrMissionDesc>${pointer}<`,
      ),
    );
    expect(parsed).toMatchObject({
      mission: RED_CROSS_MISSION,
      activitySummary: null,
      missionOnScheduleO: false,
    });
  });

  test("is kept when it states an activity first", async () => {
    const summary = "BLOOD SERVICES AND DISASTER RELIEF. SEE SCHEDULE O.";
    const parsed = await parseReturn(
      await redCrossWith(
        `<ActivityOrMissionDesc>${RED_CROSS_MISSION}<`,
        `<ActivityOrMissionDesc>${summary}<`,
      ),
    );
    expect(parsed.activitySummary).toBe(summary);
  });
});

describe("an unreadable return, rejected on its own", () => {
  async function rejection(xml: AsyncIterable<Uint8Array>) {
    const rejected = await parseReturn(xml).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(RejectedReturn);
    return rejected as RejectedReturn;
  }

  test("cut off before its form ends", async () => {
    const xml = await readFile(new URL("202640829349300109_public.xml", XML));
    expect(
      await rejection(
        Readable.from([xml.subarray(0, xml.indexOf("<MissionDesc>"))]),
      ),
    ).toMatchObject({
      reason: "unreadable",
      returnVersion: "2024v5.1",
      message: "the return ends without an IRS990 form",
    });
  });

  test("malformed", async () => {
    expect(
      await rejection(await redCrossWith("</MissionDesc>", "</Mission>")),
    ).toMatchObject({ reason: "unreadable", returnVersion: "2024v5.1" });
  });

  test("whose bytes fail to stream in", async () => {
    async function* failing() {
      yield Buffer.from(
        '<?xml version="1.0"?><Return returnVersion="2024v5.1">',
      );
      throw new Error("invalid distance too far back");
    }
    expect(await rejection(failing())).toMatchObject({
      reason: "unreadable",
      returnVersion: "2024v5.1",
      message: "invalid distance too far back",
    });
  });
});

describe("a return with schedules after its form", () => {
  const FORM_END = "</IRS990>";

  test("is parsed from the bytes up to its form's end, the stream closed unread past it", async () => {
    const xml = await readFile(new URL("202640829349300109_public.xml", XML));
    const formEnd = xml.indexOf(FORM_END) + FORM_END.length;
    let readPastForm = false;
    let closed = false;
    async function* streamed() {
      try {
        yield xml.subarray(0, formEnd);
        readPastForm = true;
        yield Buffer.from("<IRS990ScheduleO>");
      } finally {
        closed = true;
      }
    }

    const parsed = await parseReturn(streamed());

    expect(parsed).toMatchObject({
      ein: "530196605",
      mission: RED_CROSS_MISSION,
      totalRevenue: 3_916_983_933,
    });
    expect(readPastForm).toBe(false);
    expect(closed).toBe(true);
  });

  test("whose schedules never end is parsed without waiting for them", async () => {
    const xml = await readFile(new URL("202640829349300109_public.xml", XML));
    // the form and a schedule left open, in chunks the parser takes in turn
    const padded = Buffer.concat([
      xml.subarray(0, xml.indexOf(FORM_END) + FORM_END.length),
      Buffer.from("<IRS990ScheduleO><Explanation>"),
    ]);
    let pulled = 0;
    async function* endless() {
      for (let at = 0; ; at += 4096) {
        pulled++;
        if (at >= padded.length) await new Promise(() => {});
        yield padded.subarray(at, at + 4096);
      }
    }

    const parsed = await parseReturn(endless());

    expect(parsed.ein).toBe("530196605");
    // 4 KiB chunks: it stopped in the chunk that held the form's end
    expect(pulled).toBe(
      Math.ceil((xml.indexOf(FORM_END) + FORM_END.length) / 4096),
    );
  });
});
