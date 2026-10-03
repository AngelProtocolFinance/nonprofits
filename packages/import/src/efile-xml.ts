import { SaxesParser } from "saxes";
import { type FormType, formTypeOf } from "./efile-index.ts";
import { text, webAddress } from "./load.ts";

/** One Part III program service accomplishment. */
export interface Program {
  description: string | null;
  expense: number | null;
  grants: number | null;
  revenue: number | null;
}

/** What the import keeps of one e-filed return; a 990-EZ or 990-PF carries only its header facts. */
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

/** Programs kept per return. */
const TOP_PROGRAMS = 3;

const PROGRAM_FIELDS = {
  Desc: "description",
  ExpenseAmt: "expense",
  GrantAmt: "grants",
  RevenueAmt: "revenue",
} as const satisfies Record<string, keyof Program>;

/** Part III lines 4b, 4c and each 4d; line 4a's fields sit directly under IRS990. */
const PROGRAM_GROUPS = new Set([
  "ProgSrvcAccomActy2Grp",
  "ProgSrvcAccomActy3Grp",
  "ProgSrvcAccomActyOtherGrp",
]);

type FormField =
  | "mission"
  | "activitySummary"
  | "website"
  | "totalRevenue"
  | "totalExpenses"
  | "totalAssetsEoy";

/** Children of /Return/ReturnData/IRS990 read into the return. */
const FORM_FIELDS: Record<string, FormField> = {
  MissionDesc: "mission",
  ActivityOrMissionDesc: "activitySummary",
  WebsiteAddressTxt: "website",
  CYTotalRevenueAmt: "totalRevenue",
  CYTotalExpensesAmt: "totalExpenses",
  TotalAssetsEOYAmt: "totalAssetsEoy",
};

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
 * has what it keeps: the end of the IRS990 form for a 990, the end of the
 * ReturnHeader for a 990-EZ or 990-PF. A header or amount that can't be read
 * throws a `RejectedReturn`; malformed or cut-off XML throws a plain Error.
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
  const programs: Program[] = [];
  const line4a = emptyProgram();
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
      if (name === "ReturnTypeCd") returnType = content.trim();
      if (name === "TaxYr") taxYear = content.trim();
    } else if (
      section === "ReturnHeader" &&
      owner === "Filer" &&
      name === "EIN"
    ) {
      ein = content.trim();
    } else if (section === "ReturnData" && owner === "IRS990") {
      if (path.length === 4) {
        const field = FORM_FIELDS[name];
        if (field !== undefined) {
          form[field] = formValue(field, name, content, returnVersion);
        }
        setProgramField(line4a, name, content, returnVersion);
        if (PROGRAM_GROUPS.has(name)) {
          programs.push(group);
          group = emptyProgram();
        }
      } else if (path.length === 5 && child && PROGRAM_GROUPS.has(child)) {
        setProgramField(group, name, content, returnVersion);
      }
    }
    path.pop();
    if (
      (path.length === 1 && name === "ReturnHeader" && returnType !== "990") ||
      (path.length === 2 && name === "IRS990")
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
      returnType === "990"
        ? "the return ends without an IRS990 form"
        : "the return ends without a ReturnHeader",
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
    programs: topPrograms([line4a, ...programs]),
  };
}

function emptyProgram(): Program {
  return { description: null, expense: null, grants: null, revenue: null };
}

function setProgramField(
  program: Program,
  name: string,
  raw: string,
  returnVersion: string | null,
): void {
  if (!Object.hasOwn(PROGRAM_FIELDS, name)) return;
  const field = PROGRAM_FIELDS[name as keyof typeof PROGRAM_FIELDS];
  if (field === "description") program.description = text(raw);
  else program[field] = amount(name, raw, returnVersion);
}

function formValue(
  field: FormField,
  name: string,
  raw: string,
  returnVersion: string | null,
): string | number | null {
  if (field === "website") return webAddress(raw);
  if (field === "activitySummary") return text(raw);
  if (field === "mission") {
    const mission = text(raw);
    return mission !== null && SCHEDULE_O_POINTER.test(mission)
      ? null
      : mission;
  }
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
