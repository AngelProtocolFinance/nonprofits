import { SaxesParser } from "saxes";
import { type FormType, formTypeOf } from "./efile-index.ts";
import { text, webAddress } from "./load.ts";

/** One program service accomplishment: Part III of a 990 or 990-EZ. */
export interface Program {
  description: string | null;
  expense: number | null;
  grants: number | null;
  revenue: number | null;
}

/** What the import keeps of one e-filed return; a form leaves null, or no programs, what it doesn't carry. */
export interface ParsedReturn {
  returnVersion: string | null;
  formType: FormType;
  ein: string;
  taxYear: number;
  mission: string | null;
  activitySummary: string | null;
  website: string | null;
  totalRevenue: number | null;
  totalExpenses: number | null;
  totalAssetsEoy: number | null;
  /** Whether the mission is null because it only points to Schedule O. */
  missionOnScheduleO: boolean;
  /** The top 3 by expense, largest first. */
  programs: Program[];
}

/*
 * Element map, verified 2026-10-03 on every Form 990 in the 2024–2026 batch
 * zips (948,853 returns, 22 returnVersions); all paths are under
 * /Return/ReturnData/IRS990 and none moved between versions:
 *   mission           MissionDesc (Part III line 1)
 *   activity summary  ActivityOrMissionDesc (Part I line 1)
 *   website           WebsiteAddressTxt (header J)
 *   finances          CYTotalRevenueAmt, CYTotalExpensesAmt, TotalAssetsEOYAmt (Part I lines 12, 18, 20)
 *   programs          line 4a: ExpenseAmt, GrantAmt, RevenueAmt, Desc directly under IRS990;
 *                     4b ProgSrvcAccomActy2Grp, 4c ProgSrvcAccomActy3Grp, 4d ProgSrvcAccomActyOtherGrp (repeats),
 *                     each holding the same four
 *   header            ReturnHeader/ReturnTypeCd, ReturnHeader/TaxYr, ReturnHeader/Filer/EIN
 * Object ids checked, one per returnVersion (fixtures/efile/xml/):
 *   2019v5.0 202212539349300306  2019v5.1 202222529349301477  2019v5.2 202202589349300145
 *   2020v4.0 202242579349301334  2020v4.1 202212579349302081  2020v4.2 202232559349300838
 *   2021v4.0 202242579349301104  2021v4.1 202442299349300049  2021v4.2 202443529349300414
 *   2022v5.0 202431369349308428  2023v4.0 202420749349302007  2023v5.0 202433169349300518
 *   2023v5.1 202423179349308767  2023v6.0 202620389349300312  2024v5.0 202630139349301998
 *   2024v5.1 202640829349300109 (Red Cross), 202620339349301487  2024v5.2 202640389349300504
 *   2024v5.4 202621339349306127  2024v5.5 202620149349301082  2025v4.0 202610909349300811
 *   2025v4.1 202631339349308133, 202601499349300130 (irs: prefixed)  2025v4.2 202611759349301206
 */

/*
 * 990-EZ and 990-PF element maps, verified 2026-10-03 on every 990-EZ (567,510
 * returns, 22 returnVersions) and 990-PF (337,015, 21) in the 2024–2026 batch
 * zips; none moved between versions.
 * Under /Return/ReturnData/IRS990EZ:
 *   mission           PrimaryExemptPurposeTxt (Part III), in every return
 *   website           WebsiteAddressTxt (header I)
 *   finances          TotalRevenueAmt, TotalExpensesAmt (Part I lines 9, 17), Form990TotalAssetsGrp/EOYAmt
 *                     (Part II line 25 column B); 2.0% of returns leave out revenue, 3.0% expenses
 *   programs          ProgramSrvcAccomplishmentGrp (lines 28–31, repeats): DescriptionProgramSrvcAccomTxt,
 *                     ProgramServiceExpensesAmt, GrantsAndAllocationsAmt; the EZ has no program revenue
 *                     and no activity summary
 * Under /Return/ReturnData/IRS990PF:
 *   finances          AnalysisOfRevenueAndExpenses/TotalRevAndExpnssAmt (Part I line 12 column a),
 *                     AnalysisOfRevenueAndExpenses/TotalExpensesRevAndExpnssAmt (line 26 column a),
 *                     Form990PFBalanceSheetsGrp/TotalAssetsEOYAmt (Part II line 16 column b, book value;
 *                     TotalAssetsEOYFMVAmt beside it and the header's FMVAssetsEOYAmt are fair market value);
 *                     each in every return
 *   website           StatementsRegardingActyGrp/WebsiteAddressTxt (Part VII-A line 13), the only website
 *                     element in any version; in 33–100% of a version's returns
 *   The PF states no mission.
 * Object ids checked, one per returnVersion (fixtures/efile/xml/), 990-EZ:
 *   2019v5.0 202212589349200831  2019v5.1 202222529349200147  2019v5.2 202202569349201150
 *   2020v4.0 202202559349200225  2020v4.1 202343569349200609  2020v4.2 202202529349200535
 *   2021v4.0 202313579349200601  2021v4.1 202400169349201125  2021v4.2 202313569349200311
 *   2022v5.0 202303569349200015  2023v4.0 202400179349200500  2023v5.0 202400779349200160
 *   2023v5.1 202401699349200605  2023v6.0 202500159349200015  2024v5.0 202630139349200908
 *   2024v5.1 202500839349200420  2024v5.2 202501749349200125  2024v5.4 202601139349201505
 *   2024v5.5 202600139349200930  2025v4.0 202600139349200100  2025v4.1 202600899349201445
 *   2025v4.2 202601739349200690
 * 990-PF:
 *   2019v5.0 202212589349100616  2019v5.1 202202569349100505  2019v5.2 202202589349101505
 *   2020v4.0 202202529349100320  2020v4.1 202202559349100015  2020v4.2 202202529349100005
 *   2021v4.0 202400189349100205  2021v4.1 202400169349101160  2021v4.2 202400169349100065
 *   2022v5.0 202303569349100400  2023v4.0 202400179349100300  2023v5.0 202400779349100150
 *   2023v5.1 202401699349100000  2023v6.0 202630139349100013  2024v5.0 202500209349100110
 *   2024v5.1 202500829349100005  2024v5.2 202630729349100528  2024v5.5 202600139349100005
 *   2025v4.0 202600139349100200  2025v4.1 202600899349100015  2025v4.2 202601739349100050
 */

/** Programs kept per return. */
const TOP_PROGRAMS = 3;

type FormField =
  | "mission"
  | "activitySummary"
  | "website"
  | "totalRevenue"
  | "totalExpenses"
  | "totalAssetsEoy";

/** Where one form keeps what the import reads; paths are relative to the form's element. */
interface FormLayout {
  /** The form's element under /Return/ReturnData. */
  element: string;
  fields: Record<string, FormField>;
  /** Elements each holding one program. */
  programGroups: ReadonlySet<string>;
  /** A program's children, also read directly under the form when `topProgram` is set. */
  programFields: Record<string, keyof Program>;
  /** Whether fields directly under the form make a program of their own (the 990's line 4a). */
  topProgram: boolean;
}

const LAYOUTS: Record<FormType, FormLayout> = {
  "990": {
    element: "IRS990",
    fields: {
      MissionDesc: "mission",
      ActivityOrMissionDesc: "activitySummary",
      WebsiteAddressTxt: "website",
      CYTotalRevenueAmt: "totalRevenue",
      CYTotalExpensesAmt: "totalExpenses",
      TotalAssetsEOYAmt: "totalAssetsEoy",
    },
    programGroups: new Set([
      "ProgSrvcAccomActy2Grp",
      "ProgSrvcAccomActy3Grp",
      "ProgSrvcAccomActyOtherGrp",
    ]),
    programFields: {
      Desc: "description",
      ExpenseAmt: "expense",
      GrantAmt: "grants",
      RevenueAmt: "revenue",
    },
    topProgram: true,
  },
  "990-EZ": {
    element: "IRS990EZ",
    fields: {
      PrimaryExemptPurposeTxt: "mission",
      WebsiteAddressTxt: "website",
      TotalRevenueAmt: "totalRevenue",
      TotalExpensesAmt: "totalExpenses",
      "Form990TotalAssetsGrp/EOYAmt": "totalAssetsEoy",
    },
    programGroups: new Set(["ProgramSrvcAccomplishmentGrp"]),
    programFields: {
      DescriptionProgramSrvcAccomTxt: "description",
      ProgramServiceExpensesAmt: "expense",
      GrantsAndAllocationsAmt: "grants",
    },
    topProgram: false,
  },
  "990-PF": {
    element: "IRS990PF",
    fields: {
      "AnalysisOfRevenueAndExpenses/TotalRevAndExpnssAmt": "totalRevenue",
      "AnalysisOfRevenueAndExpenses/TotalExpensesRevAndExpnssAmt":
        "totalExpenses",
      "Form990PFBalanceSheetsGrp/TotalAssetsEOYAmt": "totalAssetsEoy",
      "StatementsRegardingActyGrp/WebsiteAddressTxt": "website",
    },
    programGroups: new Set(),
    programFields: {},
    topProgram: false,
  },
};

/** How many elements below its form a layout's deepest field sits; nothing deeper is matched. */
const FIELD_DEPTH = new Map(
  Object.values(LAYOUTS).map((layout) => [
    layout,
    Math.max(...Object.keys(layout.fields).map((p) => p.split("/").length)),
  ]),
);

/** Why a return is skipped on its own rather than aborting the run. */
export type RejectReason =
  | "EIN mismatch"
  | "form type mismatch"
  | "bad amount"
  | "bad TaxYr";

/** A return whose header or an amount can't be read, or doesn't match its index row. */
export class RejectedReturn extends Error {
  readonly reason: RejectReason;
  readonly returnVersion: string | null;

  constructor(
    reason: RejectReason,
    returnVersion: string | null,
    message: string,
  ) {
    super(message);
    this.reason = reason;
    this.returnVersion = returnVersion;
  }
}

/**
 * A mission that is only a pointer to Schedule O ("SEE SCHEDULE O.",
 * "CONTINUED IN SCHEDULE O"), not one that states a mission and then points there.
 */
const SCHEDULE_O_POINTER =
  /^(?:please\s+)?(?:see|refer\s+to|continued\s+(?:in|on)|see\s+mission\s+statement\s+(?:in|on)|mission\s+statement\s+is\s+\w+\s+(?:in|on))\s+(?:the\s+)?sch(?:edule|ed)?\.?\s*o\b/i;

/**
 * Parses one e-filed return as its bytes stream in, and stops reading once it
 * has what it keeps: the end of its form (IRS990, IRS990EZ or IRS990PF), or
 * of the ReturnHeader for a return type not stored. A header or amount that
 * can't be read throws a `RejectedReturn`; malformed or cut-off XML throws a
 * plain Error.
 */
export async function parseReturn(
  xml: AsyncIterable<Uint8Array>,
): Promise<ParsedReturn> {
  // some filers' software writes every element as irs:Name, so names are read without their prefix
  const parser = new SaxesParser({ xmlns: true });
  const path: string[] = [];
  let content = "";
  let returnVersion: string | null = null;
  let returnType: string | null = null;
  let ein: string | null = null;
  let taxYear: string | null = null;
  const form: Record<FormField, string | number | null> = {
    mission: null,
    activitySummary: null,
    website: null,
    totalRevenue: null,
    totalExpenses: null,
    totalAssetsEoy: null,
  };
  let layout: FormLayout | undefined;
  let missionOnScheduleO = false;
  const programs: Program[] = [];
  const topProgram = emptyProgram();
  let group = emptyProgram();
  let done = false;

  parser.on("opentag", (tag) => {
    path.push(tag.local);
    content = "";
    if (path.length === 1) {
      returnVersion = tag.attributes.returnVersion?.value ?? null;
    }
  });
  parser.on("text", (t) => {
    content += t;
  });
  parser.on("cdata", (t) => {
    content += t;
  });
  parser.on("closetag", (tag) => {
    const [, section, owner, child] = path;
    const name = tag.local;
    if (section === "ReturnHeader" && path.length === 3) {
      if (name === "ReturnTypeCd") {
        returnType = content.trim();
        const formType = formTypeOf(returnType);
        layout = formType === undefined ? undefined : LAYOUTS[formType];
      }
      if (name === "TaxYr") taxYear = content.trim();
    } else if (
      section === "ReturnHeader" &&
      owner === "Filer" &&
      name === "EIN"
    ) {
      ein = content.trim();
    } else if (
      section === "ReturnData" &&
      layout !== undefined &&
      owner === layout.element &&
      path.length > 3
    ) {
      const fieldPath =
        path.length - 3 <= (FIELD_DEPTH.get(layout) ?? 0)
          ? path.slice(3).join("/")
          : "";
      if (Object.hasOwn(layout.fields, fieldPath)) {
        const field = layout.fields[fieldPath] as FormField;
        if (field === "mission") {
          const mission = text(content);
          missionOnScheduleO =
            mission !== null && SCHEDULE_O_POINTER.test(mission);
          form.mission = missionOnScheduleO ? null : mission;
        } else {
          form[field] = formValue(field, name, content, returnVersion);
        }
      }
      if (path.length === 4) {
        if (layout.topProgram) {
          setProgramField(layout, topProgram, name, content, returnVersion);
        }
        if (layout.programGroups.has(name)) {
          programs.push(group);
          group = emptyProgram();
        }
      } else if (
        path.length === 5 &&
        child !== undefined &&
        layout.programGroups.has(child)
      ) {
        setProgramField(layout, group, name, content, returnVersion);
      }
    }
    path.pop();
    if (
      (path.length === 1 && name === "ReturnHeader" && layout === undefined) ||
      (path.length === 2 && name === layout?.element)
    ) {
      done = true;
    }
  });

  const decoder = new TextDecoder();
  for await (const chunk of xml) {
    parser.write(decoder.decode(chunk, { stream: true }));
    // leaving the loop closes the stream: the rest of the return is never read
    if (done) break;
  }
  if (!done) {
    throw new Error(
      layout === undefined
        ? "the return ends without a ReturnHeader"
        : `the return ends without an ${layout.element} form`,
    );
  }

  const formType = formTypeOf(returnType ?? "");
  if (formType === undefined) {
    throw new RejectedReturn(
      "form type mismatch",
      returnVersion,
      `ReturnTypeCd is "${returnType}"`,
    );
  }
  if (ein === null || !/^\d{9}$/.test(ein)) {
    throw new RejectedReturn(
      "EIN mismatch",
      returnVersion,
      `Filer EIN is "${ein}"`,
    );
  }
  if (taxYear === null || !/^\d{4}$/.test(taxYear)) {
    throw new RejectedReturn(
      "bad TaxYr",
      returnVersion,
      `TaxYr is "${taxYear}"`,
    );
  }
  return {
    returnVersion,
    formType,
    ein,
    taxYear: Number(taxYear),
    ...(form as Pick<ParsedReturn, FormField>),
    missionOnScheduleO,
    programs: topPrograms([topProgram, ...programs]),
  };
}

function emptyProgram(): Program {
  return { description: null, expense: null, grants: null, revenue: null };
}

function setProgramField(
  layout: FormLayout,
  program: Program,
  name: string,
  raw: string,
  returnVersion: string | null,
): void {
  if (!Object.hasOwn(layout.programFields, name)) return;
  const field = layout.programFields[name] as keyof Program;
  if (field === "description") program.description = text(raw);
  else program[field] = amount(name, raw, returnVersion);
}

function formValue(
  field: Exclude<FormField, "mission">,
  name: string,
  raw: string,
  returnVersion: string | null,
): string | number | null {
  if (field === "website") return webAddress(raw);
  if (field === "activitySummary") return text(raw);
  return amount(name, raw, returnVersion);
}

/** A whole-dollar amount; IRS e-file amounts carry no cents. */
function amount(
  name: string,
  raw: string,
  returnVersion: string | null,
): number {
  const value = raw.trim();
  const n = Number(value);
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(n)) {
    throw new RejectedReturn(
      "bad amount",
      returnVersion,
      `${name} is "${value}", expected a whole-dollar amount`,
    );
  }
  return n;
}

/** The largest programs by expense, a program with no expense after any with one; ties keep form order. */
function topPrograms(programs: readonly Program[]): Program[] {
  return programs
    .filter((p) => Object.values(p).some((v) => v !== null))
    .sort((a, b) => {
      if (a.expense === b.expense) return 0;
      if (a.expense === null) return 1;
      if (b.expense === null) return -1;
      return b.expense - a.expense;
    })
    .slice(0, TOP_PROGRAMS);
}
