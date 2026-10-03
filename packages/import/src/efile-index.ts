import type { Readable } from "node:stream";
import { type ImportFile, records } from "./load.ts";

/** The returns the e-file import stores, as `filings.form_type` writes them. */
export type FormType = "990" | "990-EZ" | "990-PF";

const FORM_TYPES: Partial<Record<string, FormType>> = {
  "990": "990",
  "990EZ": "990-EZ",
  "990PF": "990-PF",
};

/** The form type of an IRS return type code (`990EZ`), undefined for one not stored. */
export function formTypeOf(code: string): FormType | undefined {
  return FORM_TYPES[code];
}

/** One return listed in a release year's index. */
export interface IndexedFiling {
  ein: string;
  objectId: string;
  /** Empty in some years' indexes. */
  returnId: string | null;
  formType: FormType;
  /** YYYY-MM, the end of the period the return covers. */
  taxPeriod: string;
  /** YYYYDDD, the day the IRS received the return. */
  received: string;
  /** The release year whose index lists it. */
  year: number;
  /** XML_BATCH_ID upper-cased, as the batch zip is named. */
  batch: string;
}

/** What reading the indexes saw: every row, and the rows of return types not stored, by type. */
export interface IndexTally {
  rows: number;
  skipped: Record<string, number>;
}

const HEADER = [
  "RETURN_ID",
  "FILING_TYPE",
  "EIN",
  "TAX_PERIOD",
  "SUB_DATE",
  "TAXPAYER_NAME",
  "RETURN_TYPE",
  "DLN",
  "OBJECT_ID",
  "XML_BATCH_ID",
];

/**
 * The 990, 990-EZ and 990-PF returns a release year's index lists; other
 * return types (990-T) are tallied and skipped. A header or field that
 * drifted from the layout throws naming the row.
 */
export async function* indexedFilings(
  file: ImportFile,
  year: number,
  bytes: Readable,
  tally: IndexTally,
): AsyncGenerator<IndexedFiling> {
  let n = 0;
  for await (const row of records(file, bytes, { relax_column_count: true })) {
    n++;
    const drift = (detail: string) =>
      new Error(`990 index layout changed in ${file.url}: row ${n}: ${detail}`);
    if (n === 1) {
      if (row.join(",") !== HEADER.join(",")) {
        throw drift(`header is ${row.join(",")}, expected ${HEADER.join(",")}`);
      }
      continue;
    }
    if (row.length !== HEADER.length) {
      throw drift(`${row.length} fields, expected ${HEADER.length}`);
    }
    tally.rows++;
    const [
      returnId = "",
      ,
      ein = "",
      period = "",
      ,
      ,
      type = "",
      ,
      objectId = "",
      batch = "",
    ] = row;
    const formType = formTypeOf(type);
    if (formType === undefined) {
      tally.skipped[type] = (tally.skipped[type] ?? 0) + 1;
      continue;
    }
    if (!/^\d{9}$/.test(ein)) throw drift(`EIN is "${ein}"`);
    if (!/^\d{4}(0[1-9]|1[0-2])$/.test(period)) {
      throw drift(`TAX_PERIOD is "${period}", expected YYYYMM`);
    }
    const received = receivedOn(objectId);
    if (received === null) {
      throw drift(`OBJECT_ID is "${objectId}", expected 18 digits`);
    }
    // the letter ends the name of the batch's first zip; later zips take B, C…
    if (!/^\d{4}_TEOS_XML_\d{2}[A-Z]$/i.test(batch)) {
      throw drift(`XML_BATCH_ID is "${batch}", expected YYYY_TEOS_XML_NNL`);
    }
    yield {
      ein,
      objectId,
      returnId: returnId === "" ? null : returnId,
      formType,
      taxPeriod: `${period.slice(0, 4)}-${period.slice(4)}`,
      received,
      year,
      batch: batch.toUpperCase(),
    };
  }
}

/**
 * The day the IRS received a return, YYYYDDD, read off its object id: digits
 * 1–4 are the year and 6–8 the day of year. Checked equal to the receipt date
 * in the DLN (digits 6–8, year digit 14) on every 990/EZ/PF row of the
 * 2024–2026 indexes; SUB_DATE carries only the year.
 */
function receivedOn(objectId: string): string | null {
  const match = /^(\d{4})\d(\d{3})\d{10}$/.exec(objectId);
  if (match === null) return null;
  const [, year = "", day = ""] = match;
  const n = Number(day);
  return n >= 1 && n <= 366 ? `${year}${day}` : null;
}

/**
 * Whether `a` supersedes `b` as an EIN's latest filing: a later tax period,
 * else received later (so an amended return replaces the one it amends), else
 * the higher object id, so the pick never depends on index order.
 */
function isLater(a: IndexedFiling, b: IndexedFiling): boolean {
  if (a.taxPeriod !== b.taxPeriod) return a.taxPeriod > b.taxPeriod;
  if (a.received !== b.received) return a.received > b.received;
  return a.objectId > b.objectId;
}

/** Each EIN's latest filing among `filings`. */
export async function latestPerEin(
  filings: AsyncIterable<IndexedFiling>,
): Promise<Map<string, IndexedFiling>> {
  const latest = new Map<string, IndexedFiling>();
  for await (const filing of filings) {
    const kept = latest.get(filing.ein);
    if (kept === undefined || isLater(filing, kept)) {
      latest.set(filing.ein, filing);
    }
  }
  return latest;
}
