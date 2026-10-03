import { createReadStream } from "node:fs";
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
