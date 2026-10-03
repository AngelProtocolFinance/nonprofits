import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimSlotSql,
  READ_ACTIVE_SLOT_SQL,
  READ_DATA_META_SQL,
  releaseClaimSql,
  resetGenerationSql,
} from "@nonprofits/db";
import { type Zippable, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EFILE_FLOORS } from "./efile.ts";
import { refresh, rollback } from "./generation.ts";
import type { SourceConfig } from "./sources.ts";
import { migrateAppDb, type Route, serve } from "./test-support.ts";
import { type D1Ops, localD1 } from "./wrangler.ts";

const FIXTURES = new URL("../fixtures/", import.meta.url);
const BMF_FILES = ["eo1.csv", "eo2.csv", "eo3.csv", "eo4.csv"];
const LISTS = ["pub78", "revocation", "epostcard"] as const;
const RELEASED = "Wed, 16 Sep 2026 13:02:21 GMT";
/** The fixture returns each batch zip holds, as `efile.test.ts` serves them. */
const ZIPS: Record<string, string[]> = {
  "2026_TEOS_XML_01A": [
    "202630139349301998",
    "202620149349301082",
    "202630139349200908",
    "202630139349100013",
  ],
  "2026_TEOS_XML_02A": [
    "202620389349300312",
    "202640389349300504",
    "202620339349301487",
  ],
  "2026_TEOS_XML_03A": ["202640829349300109", "202630729349100528"],
  "2026_TEOS_XML_05A": ["202620339349301487"],
  "2026_TEOS_XML_05B": ["202631339349308133"],
  "2026_TEOS_XML_06A": ["202601499349300130"],
  "2024_TEOS_XML_05A": ["202431369349308428"],
};
const RED_CROSS =
  "SELECT o.name, f.mission FROM orgs o JOIN filings f ON f.ein = o.ein WHERE o.ein = '530196605'";

let server: Server;
let base: string;
let work: string;
let ops: D1Ops;

function sources(bmf: readonly string[] = BMF_FILES): SourceConfig {
  return {
    bmf: { urls: bmf.map((name) => `${base}/${name}`), minOrgs: 1 },
    lists: {
      pub78: { url: `${base}/pub78.zip`, minRows: 1 },
      revocation: { url: `${base}/revocation.zip`, minRows: 1 },
      epostcard: { url: `${base}/epostcard.zip`, minRows: 1 },
    },
    efile: {
      baseUrl: `${base}/xml/`,
      latestYear: 2026,
      floors: EFILE_FLOORS,
      workDir: join(work, "efile"),
    },
  };
}

function run(options: { bmf?: readonly string[]; via?: D1Ops } = {}) {
  return refresh(options.via ?? ops, {
    sources: sources(options.bmf),
    loadDir: join(work, "load"),
    log: () => {},
  });
}

/** `ops`, keeping the text of every SQL file it applies in `applied`. */
function recording(applied: string[]): D1Ops {
  return {
    async applyFile(binding, file) {
      applied.push(await readFile(file, "utf8"));
      await ops.applyFile(binding, file);
    },
    query: (binding, sql) => ops.query(binding, sql),
  };
}

/** Dates the last flip; a long-past one lets a refresh reset the slot it left straight away. */
const setFlippedAt = (at: string) =>
  ops.query(
    "APP_DB",
    `UPDATE data_generation SET flipped_at = '${at}' WHERE id = 1`,
  );
const LONG_AGO = "2000-01-01T00:00:00Z";

const pointer = () =>
  ops.query<{ active: string; build_id: string }>(
    "APP_DB",
    READ_ACTIVE_SLOT_SQL,
  );

beforeAll(async () => {
  const routes = new Map<string, Route>();
  for (const name of BMF_FILES) {
    routes.set(
      `/${name}`,
      await readFile(new URL(`bmf/${name}`, FIXTURES), "utf8"),
    );
  }
  for (const list of LISTS) {
    const name = `data-download-${list}.txt`;
    const text = await readFile(new URL(`lists/${name}`, FIXTURES));
    routes.set(`/${list}.zip`, zipSync({ [name]: [text, { level: 6 }] }));
  }
  for (const year of [2024, 2025, 2026]) {
    routes.set(
      `/xml/${year}/index_${year}.csv`,
      await readFile(new URL(`efile/index_${year}.csv`, FIXTURES)),
    );
  }
  for (const [batch, objectIds] of Object.entries(ZIPS)) {
    const files: Zippable = {};
    for (const id of objectIds) {
      files[`${id}_public.xml`] = [
        await readFile(new URL(`efile/xml/${id}_public.xml`, FIXTURES)),
        { level: 6 },
      ];
    }
    routes.set(`/xml/${batch.slice(0, 4)}/${batch}.zip`, zipSync(files));
  }
  ({ server, base } = await serve(routes, RELEASED));
  work = await mkdtemp(join(tmpdir(), "generation-"));
  const persistTo = join(work, "d1");
  await migrateAppDb(persistTo);
  ops = localD1(persistTo);
}, 60_000);

afterAll(async () => {
  server?.close();
  if (work) await rm(work, { recursive: true, force: true });
});

// each test starts from the generations and pointer the one before it left
describe("refresh and rollback", { timeout: 180_000 }, () => {
  const firstBuild: string[] = [];

  test("refresh builds the inactive slot and points the Worker at it", async () => {
    const report = await run({ via: recording(firstBuild) });

    expect(report).toMatchObject({ slot: "b", previous: "a" });
    expect(await pointer()).toStrictEqual([
      { active: "b", build_id: report.buildId },
    ]);
    expect(await ops.query("DATA_DB_B", READ_DATA_META_SQL)).toStrictEqual([
      { slot: "b", build_id: report.buildId, state: "complete" },
    ]);
    expect(await ops.query("DATA_DB_B", RED_CROSS)).toStrictEqual([
      {
        name: "AMERICAN NATIONAL RED CROSS",
        mission:
          "THE AMERICAN RED CROSS PREVENTS AND ALLEVIATES HUMAN SUFFERING IN THE FACE OF EMERGENCIES BY MOBILIZING THE POWER OF VOLUNTEERS AND THE GENEROSITY OF DONORS.",
      },
    ]);
    expect(
      await ops.query(
        "DATA_DB_A",
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ),
    ).toStrictEqual([]);
  });

  test("a refresh rebuilds the search index once, over every source's names", async () => {
    const rebuilds = firstBuild.flatMap(
      (sql) => sql.match(/VALUES \('delete-all'\)/g) ?? [],
    );
    expect(rebuilds).toHaveLength(1);
    for (const [words, rowid] of [
      ["red cross", 530196605],
      // named only by Pub 78 and the revocation list
      ["fundraising professionals", 999999010],
      ["green valley", 10281533],
    ] as const) {
      expect(
        await ops.query(
          "DATA_DB_B",
          `SELECT rowid FROM orgs_fts WHERE orgs_fts MATCH '${words}'`,
        ),
      ).toStrictEqual([{ rowid }]);
    }
  });

  test("a refresh that fails verify leaves the pointer and the served Red Cross unchanged", async () => {
    await setFlippedAt(LONG_AGO);
    const before = await pointer();
    const served = await ops.query("DATA_DB_B", RED_CROSS);

    // three of the four BMF regions: far fewer orgs than the generation served
    await expect(run({ bmf: ["eo1.csv"] })).rejects.toThrow(
      /verify failed.*orgs: \d+, served \d+/s,
    );

    expect(await pointer()).toStrictEqual(before);
    expect(await ops.query("DATA_DB_B", RED_CROSS)).toStrictEqual(served);
    expect(await ops.query("DATA_DB_A", READ_DATA_META_SQL)).toMatchObject([
      { slot: "a", state: "building" },
    ]);
  });

  test("rollback refuses a slot whose build never completed, naming the Time Travel restore", async () => {
    const before = await pointer();
    const [failed] = await ops.query<{ build_id: string }>(
      "DATA_DB_A",
      READ_DATA_META_SQL,
    );

    await expect(rollback(ops)).rejects.toThrow(
      `wrangler d1 time-travel restore DATA_DB_A --timestamp=${failed?.build_id}`,
    );
    expect(await pointer()).toStrictEqual(before);
  });

  test("a refresh refuses to reset a database whose data_meta names the served slot", async () => {
    const before = await pointer();
    // DATA_DB_A wired to the served database would read like this
    const imposter = join(work, "imposter.sql");
    await writeFile(imposter, resetGenerationSql("b", "served"));
    await ops.applyFile("DATA_DB_A", imposter);

    await expect(run()).rejects.toThrow("DATA_DB_A holds slot b's generation");
    expect(await pointer()).toStrictEqual(before);
    expect(await ops.query("DATA_DB_A", READ_DATA_META_SQL)).toStrictEqual([
      { slot: "b", build_id: "served", state: "building" },
    ]);
  });

  test("a refresh refuses to start while another build holds the claim", async () => {
    await ops.query(
      "APP_DB",
      claimSlotSql("a", "elsewhere", new Date().toISOString()),
    );

    await expect(run()).rejects.toThrow("another build holds its claim");
    expect(await ops.query("DATA_DB_A", READ_DATA_META_SQL)).toStrictEqual([
      { slot: "b", build_id: "served", state: "building" },
    ]);
    await ops.query("APP_DB", releaseClaimSql("elsewhere"));
  });

  test("a refresh resets the slot a flip left only after the Workers' 30 s pointer cache", async () => {
    // A back to what a failed build leaves, for the refresh to take
    const failed = join(work, "failed-a.sql");
    await writeFile(failed, resetGenerationSql("a", "failed"));
    await ops.applyFile("DATA_DB_A", failed);
    const flippedAt = Date.now() - 5_000;
    await setFlippedAt(new Date(flippedAt).toISOString());
    let resetAt: number | undefined;
    const timing: D1Ops = {
      applyFile(binding, file) {
        resetAt ??= Date.now();
        return ops.applyFile(binding, file);
      },
      query: (binding, sql) => ops.query(binding, sql),
    };

    expect(await run({ via: timing })).toMatchObject({
      slot: "a",
      previous: "b",
    });
    expect((resetAt ?? 0) - flippedAt).toBeGreaterThanOrEqual(30_000);
  });

  test("rollback flips back to the previous complete generation", async () => {
    const [b] = await ops.query<{ build_id: string }>(
      "DATA_DB_B",
      READ_DATA_META_SQL,
    );

    expect(await rollback(ops)).toStrictEqual({
      from: "a",
      to: "b",
      buildId: b?.build_id,
    });
    expect(await pointer()).toStrictEqual([
      { active: "b", build_id: b?.build_id },
    ]);
  });

  test("the flip fails when the pointer moved during the run", async () => {
    await setFlippedAt(LONG_AGO);
    const interloping: D1Ops = {
      applyFile: (binding, file) => ops.applyFile(binding, file),
      async query(binding, sql) {
        if (sql.startsWith("UPDATE data_meta SET state = 'complete'")) {
          await ops.query(
            "APP_DB",
            `UPDATE data_generation SET active = 'a', build_id = 'elsewhere', claim_slot = NULL, claim_build_id = NULL, claimed_at = NULL, claim_expires_at = NULL WHERE id = 1`,
          );
        }
        return ops.query(binding, sql);
      },
    };

    await expect(run({ via: interloping })).rejects.toThrow(
      "the pointer moved off slot b",
    );
    expect(await pointer()).toStrictEqual([
      { active: "a", build_id: "elsewhere" },
    ]);
  });
});
