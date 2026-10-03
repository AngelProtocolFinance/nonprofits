import { Readable } from "node:stream";
import type { ImportSource } from "@nonprofits/db";
import {
  batched,
  download,
  type ImportFile,
  insertRun,
  literal,
  MAX_STATEMENT_BYTES,
  ORGS,
  type OrgUpsert,
  records,
  setRowCount,
  text,
  tuple,
  upsertOrgs,
  writeLoad,
} from "./load.ts";
import { applyLoad, type D1Target } from "./wrangler.ts";
import { firstZipEntry } from "./zip.ts";

const EPOSTCARD_DOWNLOADS = "https://apps.irs.gov/pub/epostcard/";

/** The IRS lists beside the BMF, each a zipped `|`-delimited text file with no header. */
export const LISTS = {
  pub78: {
    url: `${EPOSTCARD_DOWNLOADS}data-download-pub78.zip`,
    minRows: 1_277_000,
  },
  revocation: {
    url: `${EPOSTCARD_DOWNLOADS}data-download-revocation.zip`,
    minRows: 1_122_000,
  },
  epostcard: {
    url: `${EPOSTCARD_DOWNLOADS}data-download-epostcard.zip`,
    minRows: 1_392_000,
  },
} as const;
export type ListName = keyof typeof LISTS;

interface Layout {
  source: ImportSource & ListName;
  label: string;
  /** Fields per row. */
  fields: number;
  /** A free-text field the IRS writes `|` into unescaped; a wider row has its overflow there, read as empty. */
  freeText?: number;
  upsert: OrgUpsert;
  /** What the list says about an org it lists, and the SET clauses that unsay it. */
  unlisted: { listed: string; clear: readonly string[] };
  /** One row's values, in `upsert.columns` order; a `FieldError` for a field that can't be read. */
  values(row: readonly string[]): (string | null)[];
}

/** A field whose content says the layout has moved. */
class FieldError extends Error {}

const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

/** `15-NOV-2025` as `2025-11-15`; null for an empty optional date. */
function date(raw: string, field: number, required: boolean): string | null {
  if (raw === "" && !required) return null;
  const [, day, month = "", year] =
    /^(\d{2})-([A-Z]{3})-(\d{4})$/.exec(raw) ?? [];
  const m = MONTHS.indexOf(month) + 1;
  if (day === undefined || m === 0) {
    throw new FieldError(
      `field ${field} is "${raw}", expected a DD-MON-YYYY date`,
    );
  }
  return `${year}-${String(m).padStart(2, "0")}-${day}`;
}

/** A host with a dot and a letters-only TLD, with an optional scheme, port and path. */
const WEB_ADDRESS =
  /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i;

/** Free text typed as a website: null unless it reads as a web address. */
function webAddress(raw: string): string | null {
  const value = text(raw);
  return value !== null && WEB_ADDRESS.test(value) ? value : null;
}

const LAYOUTS: Record<ListName, Layout> = {
  pub78: {
    source: "pub78",
    label: "Pub 78",
    // EIN|NAME|CITY|STATE|COUNTRY|DEDUCTIBILITY STATUS
    fields: 6,
    upsert: {
      source: "pub78",
      columns: ["ein", "name", "city", "state"],
      derived: [["in_pub78", "1"]],
      facts: ["in_pub78 = 1"],
    },
    unlisted: { listed: "in_pub78 = 1", clear: ["in_pub78 = 0"] },
    values: ([ein = "", name = "", city = "", state = ""]) => [
      ein,
      text(name),
      text(city),
      text(state),
    ],
  },
  revocation: {
    source: "revocation",
    label: "Revocation list",
    // EIN|LEGAL NAME|DBA|STREET|CITY|STATE|ZIP|COUNTRY|EXEMPTION TYPE|
    // REVOCATION DATE|REVOCATION POSTING DATE|REINSTATEMENT DATE
    fields: 12,
    upsert: {
      source: "revocation",
      columns: [
        "ein",
        "name",
        "street",
        "city",
        "state",
        "zip",
        "revocation_date",
        "reinstatement_date",
      ],
      // an EIN listed twice keeps its latest revocation, with that one's reinstatement
      facts: ["revocation_date", "reinstatement_date"].map(
        (column) =>
          `${column} = iif(${ORGS}.revocation_date > excluded.revocation_date, ${ORGS}.${column}, excluded.${column})`,
      ),
    },
    unlisted: {
      listed: "revocation_date IS NOT NULL",
      clear: ["revocation_date = NULL", "reinstatement_date = NULL"],
    },
    values: (row) => [
      row[0] ?? "",
      ...[1, 3, 4, 5, 6].map((i) => text(row[i] ?? "")),
      date(row[9] ?? "", 10, true),
      date(row[11] ?? "", 12, false),
    ],
  },
  epostcard: {
    source: "epostcard",
    label: "e-Postcard",
    // EIN|TAX YEAR|NAME|GROSS RECEIPTS UNDER 50K|TERMINATED|TAX PERIOD BEGIN|
    // TAX PERIOD END|WEBSITE|then officer address, mailing address, 3 DBA names
    fields: 26,
    upsert: {
      source: "epostcard",
      columns: ["ein", "epostcard_website"],
      derived: [["files_990n", "1"]],
      facts: [
        "files_990n = 1",
        "epostcard_website = excluded.epostcard_website",
      ],
    },
    unlisted: {
      listed: "files_990n = 1",
      clear: ["files_990n = 0", "epostcard_website = NULL"],
    },
    freeText: 7,
    values: ([ein = "", , , , , , , website = ""]) => [
      ein,
      webAddress(website),
    ],
  },
};

export interface ListImportOptions {
  url: string;
  /** Fewer rows than this aborts before anything is applied. */
  minRows: number;
  /** Where the generated SQL load file is written. */
  out: string;
  target: D1Target;
  /** Largest upsert statement written, in bytes; defaults under D1's 100 KB limit. */
  maxStatementBytes?: number;
}

export interface ListImportSummary {
  url: string;
  /** The file's Last-Modified, ISO-8601. */
  releasedAt: string;
  rows: number;
}

/**
 * Streams one list's zip into a SQL load file, then applies it to D1 in a
 * single `wrangler d1 execute --file`, so its rows and its `import_runs` row
 * commit together. A failed download, any layout drift or a short count throws
 * before the apply, leaving D1 untouched and no load file behind.
 */
export async function importList(
  list: ListName,
  options: ListImportOptions,
): Promise<ListImportSummary> {
  const layout = LAYOUTS[list];
  const file: ImportFile = {
    source: layout.source,
    label: layout.label,
    url: options.url,
  };
  let summary: ListImportSummary | undefined;
  await writeLoad(
    options.out,
    (async function* () {
      summary = yield* listSql(layout, file, options);
    })(),
  );
  await applyLoad(options.out, options.target);
  return summary as ListImportSummary;
}

async function* listSql(
  layout: Layout,
  file: ImportFile,
  { minRows, maxStatementBytes = MAX_STATEMENT_BYTES }: ListImportOptions,
): AsyncGenerator<string, ListImportSummary> {
  const { body, releasedAt } = await download(file);
  yield insertRun(file, releasedAt, new Date().toISOString());
  let rows = 0;
  async function* listed(): AsyncGenerator<Listed> {
    const entry = Readable.from(firstZipEntry(Readable.fromWeb(body)));
    let previous = "";
    for await (const row of records(file, entry, {
      delimiter: "|",
      quote: false,
      relax_column_count: true,
      skip_empty_lines: true,
    })) {
      rows++;
      const values = rowValues(layout, file, row, rows);
      const ein = values[0] ?? "";
      if (ein < previous) {
        throw new Error(
          `${file.label} layout changed in ${file.url}: row ${rows}: EIN ${ein} follows ${previous}, expected EIN order`,
        );
      }
      previous = ein;
      yield { ein, tuple: tuple(values) };
    }
  }
  // each batch also unflags the orgs between the last batch's final EIN and its own that it doesn't list
  let after = "";
  yield* batched(
    listed(),
    (row) => row.tuple,
    (batch) => {
      const last = batch.at(-1)?.ein;
      const sql =
        upsertOrgs(
          layout.upsert,
          batch.map((row) => row.tuple),
        ) +
        clearUnlisted(
          layout,
          after,
          last,
          batch.map((row) => row.ein),
        );
      if (last !== undefined) after = last;
      return sql;
    },
    maxStatementBytes,
  );
  yield clearUnlisted(layout, after);
  if (rows < minRows) {
    throw new Error(
      `${file.label} import aborted: ${rows} rows is below the floor of ${minRows}; nothing was loaded`,
    );
  }
  yield setRowCount(layout.source, rows);
  return { url: file.url, releasedAt, rows };
}

/** A row's upsert tuple, with its EIN. */
interface Listed {
  ein: string;
  tuple: string;
}

/**
 * Unflags the orgs with an EIN above `after` (and up to `through`) that this
 * run doesn't list. The file is in EIN order, so no later batch lists them;
 * only rows that change are written.
 */
function clearUnlisted(
  layout: Layout,
  after: string,
  through?: string,
  listed: readonly string[] = [],
): string {
  const where = [
    layout.unlisted.listed,
    `ein > ${literal(after)}`,
    ...(through === undefined ? [] : [`ein <= ${literal(through)}`]),
    ...(listed.length === 0
      ? []
      : [`ein NOT IN (${listed.map(literal).join(", ")})`]),
  ];
  return `UPDATE ${ORGS} SET ${layout.unlisted.clear.join(", ")} WHERE ${where.join(" AND ")};\n`;
}

function rowValues(
  layout: Layout,
  file: ImportFile,
  row: readonly string[],
  n: number,
): (string | null)[] {
  const { fields, freeText } = layout;
  const overflow = row.length - fields;
  // row 1 is held to the exact width, so a column added to every row can't pass as overflow
  if (overflow < 0 || (overflow > 0 && (freeText === undefined || n === 1))) {
    throw new Error(
      `${file.label} layout changed in ${file.url}: row ${n} has ${row.length} fields, expected ${fields}`,
    );
  }
  const fitted =
    freeText !== undefined && overflow > 0
      ? [...row.slice(0, freeText), "", ...row.slice(freeText + overflow + 1)]
      : row;
  try {
    return layout.values(fitted);
  } catch (error) {
    if (!(error instanceof FieldError)) throw error;
    throw new Error(
      `${file.label} layout changed in ${file.url}: row ${n}: ${error.message}`,
    );
  }
}
