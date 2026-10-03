import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  type IndexedFiling,
  type IndexTally,
  indexedFilings,
  latestPerEin,
} from "./efile-index.ts";

const SELECTION = new URL("../fixtures/efile/selection/", import.meta.url);

/** The selection fixture's index for each of `years`, read in turn. */
async function* fixtureIndexes(
  years: readonly number[],
  tally: IndexTally = { rows: 0, skipped: {} },
): AsyncGenerator<IndexedFiling> {
  for (const year of years) {
    const path = fileURLToPath(new URL(`index_${year}.csv`, SELECTION));
    yield* indexedFilings(
      { source: "efile_index", label: "990 index", url: path },
      year,
      createReadStream(path),
      tally,
    );
  }
}

async function latestObjectIds(
  years: readonly number[],
): Promise<Map<string, string>> {
  const latest = await latestPerEin(fixtureIndexes(years));
  return new Map([...latest].map(([ein, f]) => [ein, f.latest.objectId]));
}

describe("the latest filing per EIN", () => {
  test("is the one for the latest tax period, though an older period was filed after it", async () => {
    const latest = await latestObjectIds([2026, 2025, 2024]);
    // 202503 filed 2026-166 beats 202403 filed 2026-195
    expect(latest.get("010027748")).toBe("202601669349301260");
    // 202412 filed 2025-319 beats the 202312 amendment filed 2026-013
    expect(latest.get("010368574")).toBe("202533199349301038");
  });

  test("for one tax period is the one received last, an amendment included", async () => {
    const latest = await latestObjectIds([2024]);
    // received 2024-288, though its object id sorts below the 2024-135 one
    expect(latest.get("010224898")).toBe("202422889349300412");
  });

  test("received the same day as another for its tax period is the higher object id", async () => {
    const latest = await latestObjectIds([2026]);
    expect(latest.get("010541478")).toBe("202610449349300946");
  });

  test("is never a 990-T", async () => {
    const latest = await latestPerEin(fixtureIndexes([2026, 2025, 2024]));
    expect(latest.get("530196605")?.latest).toEqual({
      ein: "530196605",
      objectId: "202640829349300109",
      returnId: "24433471",
      formType: "990",
      taxPeriod: "2025-06",
      received: "2026082",
      year: 2026,
      batch: "2026_TEOS_XML_03A",
    });
  });

  test("may be a 990-EZ after earlier 990s", async () => {
    const latest = await latestPerEin(fixtureIndexes([2026, 2025, 2024]));
    expect(latest.get("010223446")?.latest).toMatchObject({
      objectId: "202521399349201707",
      returnId: "23551101",
      formType: "990-EZ",
      taxPeriod: "2024-12",
    });
  });

  test("counts every index row, tallying the return types it skips", async () => {
    const tally: IndexTally = { rows: 0, skipped: {} };
    for await (const _ of fixtureIndexes([2026, 2025, 2024], tally));
    expect(tally).toEqual({ rows: 23, skipped: { "990T": 3 } });
  });
});

describe("the runner-up filing per EIN, loaded when the latest is rejected", () => {
  async function runnersUp(
    years: readonly number[],
  ): Promise<Map<string, string | undefined>> {
    const ranked = await latestPerEin(fixtureIndexes(years));
    return new Map([...ranked].map(([ein, f]) => [ein, f.runnerUp?.objectId]));
  }

  test("is the next-latest, whichever index lists it and in whatever order", async () => {
    const runnerUp = await runnersUp([2026, 2025, 2024]);
    // latest 202506; read after it, 202406 beats the two 202306 returns
    expect(runnerUp.get("010224898")).toBe("202521339349301142");
    // latest 202503 filed 2026-166; 202403 filed 2026-195 is read after it
    expect(runnerUp.get("010027748")).toBe("202641959349301799");
  });

  test("is the one a later-read latest displaced", async () => {
    // received 2024-135, then displaced by the 2024-288 amendment
    expect((await runnersUp([2024])).get("010224898")).toBe(
      "202431359349303488",
    );
    // the same day's lower object id
    expect((await runnersUp([2026])).get("010541478")).toBe(
      "202600449349300805",
    );
  });

  test("is never a 990-T", async () => {
    expect((await runnersUp([2026, 2025, 2024])).get("530196605")).toBe(
      "202511189349301681",
    );
  });

  test("is absent for an EIN with one filing", async () => {
    const runnerUp = await runnersUp([2025]);
    // 2025 lists only its 990-EZ
    expect(runnerUp.has("010223446")).toBe(true);
    expect(runnerUp.get("010223446")).toBeUndefined();
  });
});

const INDEX_URL = "https://irs.test/2026/index_2026.csv";
const INDEX_HEADER =
  "RETURN_ID,FILING_TYPE,EIN,TAX_PERIOD,SUB_DATE,TAXPAYER_NAME,RETURN_TYPE,DLN,OBJECT_ID,XML_BATCH_ID";

/** An index row for a Form 990 whose fields are valid but for the `fields` given by column position. */
function indexRow(fields: Record<number, string> = {}): string {
  const row = [
    "24099284",
    "EFILE",
    "131520977",
    "202509",
    "2026",
    "AN ORG",
    "990",
    "93493013019986",
    "202630139349301998",
    "2026_TEOS_XML_01A",
  ];
  for (const [column, value] of Object.entries(fields)) {
    row[Number(column)] = value;
  }
  return row.join(",");
}

const EIN = 2;
const TAX_PERIOD = 3;
const RETURN_TYPE = 6;
const OBJECT_ID = 8;
const BATCH = 9;

/** Reads index `lines` (the header first) as the IRS writes them, CRLF-separated. */
async function readIndex(
  lines: readonly string[],
  tally: IndexTally = { rows: 0, skipped: {} },
): Promise<IndexedFiling[]> {
  const filings: IndexedFiling[] = [];
  const file = {
    source: "efile_index" as const,
    label: "990 index",
    url: INDEX_URL,
  };
  const text = `${lines.join("\r\n")}\r\n`;
  for await (const filing of indexedFilings(
    file,
    2026,
    Readable.from([text]),
    tally,
  )) {
    filings.push(filing);
  }
  return filings;
}

const drift = (row: number, detail: string) =>
  `990 index layout changed in ${INDEX_URL}: row ${row}: ${detail}`;

describe("an index whose layout drifted from the one the import reads", () => {
  test.each([
    {
      name: "a renamed column",
      lines: [INDEX_HEADER.replace(",EIN,", ",TIN,"), indexRow()],
      message: drift(
        1,
        `header is ${INDEX_HEADER.replace(",EIN,", ",TIN,")}, expected ${INDEX_HEADER}`,
      ),
    },
    {
      name: "a dropped column",
      lines: [INDEX_HEADER.replace("FILING_TYPE,", ""), indexRow()],
      message: drift(
        1,
        `header is ${INDEX_HEADER.replace("FILING_TYPE,", "")}, expected ${INDEX_HEADER}`,
      ),
    },
    {
      name: "a row with a field missing",
      lines: [INDEX_HEADER, indexRow(), indexRow().replace(",EFILE", "")],
      message: drift(3, "9 fields, expected 10"),
    },
    {
      name: "a row with a field too many",
      lines: [INDEX_HEADER, `${indexRow()},EXTRA`],
      message: drift(2, "11 fields, expected 10"),
    },
    {
      name: "an EIN of 8 digits",
      lines: [INDEX_HEADER, indexRow({ [EIN]: "13152097" })],
      message: drift(2, 'EIN is "13152097"'),
    },
    {
      name: "a hyphenated EIN",
      lines: [INDEX_HEADER, indexRow({ [EIN]: "13-1520977" })],
      message: drift(2, 'EIN is "13-1520977"'),
    },
    {
      name: "an empty EIN",
      lines: [INDEX_HEADER, indexRow({ [EIN]: "" })],
      message: drift(2, 'EIN is ""'),
    },
    {
      name: "a TAX_PERIOD with month 13",
      lines: [INDEX_HEADER, indexRow({ [TAX_PERIOD]: "202513" })],
      message: drift(2, 'TAX_PERIOD is "202513", expected YYYYMM'),
    },
    {
      name: "a TAX_PERIOD with month 00",
      lines: [INDEX_HEADER, indexRow({ [TAX_PERIOD]: "202500" })],
      message: drift(2, 'TAX_PERIOD is "202500", expected YYYYMM'),
    },
    {
      name: "a TAX_PERIOD written YYYY-MM",
      lines: [INDEX_HEADER, indexRow({ [TAX_PERIOD]: "2025-09" })],
      message: drift(2, 'TAX_PERIOD is "2025-09", expected YYYYMM'),
    },
    {
      name: "an OBJECT_ID of 17 digits",
      lines: [INDEX_HEADER, indexRow({ [OBJECT_ID]: "20263013934930199" })],
      message: drift(2, 'OBJECT_ID is "20263013934930199", expected 18 digits'),
    },
    {
      name: "an OBJECT_ID with a letter",
      lines: [INDEX_HEADER, indexRow({ [OBJECT_ID]: "20263013934930199X" })],
      message: drift(
        2,
        'OBJECT_ID is "20263013934930199X", expected 18 digits',
      ),
    },
    {
      name: "an OBJECT_ID whose day of year is 000",
      lines: [INDEX_HEADER, indexRow({ [OBJECT_ID]: "202630009349301998" })],
      message: drift(
        2,
        'OBJECT_ID is "202630009349301998", expected 18 digits',
      ),
    },
    {
      name: "an OBJECT_ID whose day of year is 367",
      lines: [INDEX_HEADER, indexRow({ [OBJECT_ID]: "202633679349301998" })],
      message: drift(
        2,
        'OBJECT_ID is "202633679349301998", expected 18 digits',
      ),
    },
    {
      name: "an XML_BATCH_ID without its zip letter",
      lines: [INDEX_HEADER, indexRow({ [BATCH]: "2026_TEOS_XML_01" })],
      message: drift(
        2,
        'XML_BATCH_ID is "2026_TEOS_XML_01", expected YYYY_TEOS_XML_NNL',
      ),
    },
    {
      name: "an XML_BATCH_ID with a one-digit number",
      lines: [INDEX_HEADER, indexRow({ [BATCH]: "2026_TEOS_XML_1A" })],
      message: drift(
        2,
        'XML_BATCH_ID is "2026_TEOS_XML_1A", expected YYYY_TEOS_XML_NNL',
      ),
    },
    {
      name: "an XML_BATCH_ID renamed",
      lines: [INDEX_HEADER, indexRow({ [BATCH]: "2026_TEOS_01A" })],
      message: drift(
        2,
        'XML_BATCH_ID is "2026_TEOS_01A", expected YYYY_TEOS_XML_NNL',
      ),
    },
  ])("throws on $name, naming the file and row", async ({ lines, message }) => {
    await expect(readIndex(lines)).rejects.toThrow(`${message}`);
  });

  test("throws on a row after the valid ones that came before it", async () => {
    const tally: IndexTally = { rows: 0, skipped: {} };

    await expect(
      readIndex([INDEX_HEADER, indexRow(), indexRow({ [EIN]: "1" })], tally),
    ).rejects.toThrow(drift(3, 'EIN is "1"'));
    // the valid row before it was counted: the throw is not the first row's
    expect(tally.rows).toBe(2);
  });

  test("reads rows at the edges of what it accepts", async () => {
    const filings = await readIndex([
      INDEX_HEADER,
      indexRow({ [TAX_PERIOD]: "202501", [OBJECT_ID]: "202630019349301998" }),
      indexRow({ [TAX_PERIOD]: "202512", [OBJECT_ID]: "202633669349301998" }),
    ]);

    expect(filings.map((f) => [f.taxPeriod, f.received])).toStrictEqual([
      ["2025-01", "2026001"],
      ["2025-12", "2026366"],
    ]);
  });

  test("tallies a return type it doesn't store without reading its other fields", async () => {
    const tally: IndexTally = { rows: 0, skipped: {} };

    const filings = await readIndex(
      [
        INDEX_HEADER,
        indexRow({ [RETURN_TYPE]: "990T", [EIN]: "", [OBJECT_ID]: "" }),
        indexRow(),
      ],
      tally,
    );

    expect(filings.map((f) => f.ein)).toStrictEqual(["131520977"]);
    expect(tally).toStrictEqual({ rows: 2, skipped: { "990T": 1 } });
  });
});
