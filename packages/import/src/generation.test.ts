import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimSlotSql,
  flipActiveSlotSql,
  READ_DATA_META_SQL,
  releaseClaimSql,
  resetGenerationSql,
} from "@nonprofits/db";
import { type Zippable, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EFILE_FLOORS } from "./efile.ts";
import {
  FLIP_SETTLE_MS,
  refresh,
  releaseClaim,
  rollback,
  type TableFloors,
} from "./generation.ts";
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

/** Floors the fixtures clear. */
const FIXTURE_FLOORS: TableFloors = { orgs: 1, filings: 1, programs: 1 };

function run(
  options: { bmf?: readonly string[]; floors?: TableFloors; via?: D1Ops } = {},
) {
  return refresh(options.via ?? ops, {
    sources: sources(options.bmf),
    floors: options.floors ?? FIXTURE_FLOORS,
    loadDir: join(work, "load"),
    log: () => {},
  });
}

/** `ops`, but `onQuery` sees each query first and may answer it instead. */
function intercepting(
  onQuery: (sql: string) => Promise<unknown[] | undefined>,
): D1Ops {
  return {
    remote: false,
    applyFile: (binding, file) => ops.applyFile(binding, file),
    async query<T>(binding: Parameters<D1Ops["query"]>[0], sql: string) {
      const answer = await onQuery(sql);
      return (answer as T[] | undefined) ?? ops.query<T>(binding, sql);
    },
  };
}

/** `ops`, keeping the text of every SQL file it applies in `applied`. */
function recording(applied: string[]): D1Ops {
  return {
    remote: false,
    async applyFile(binding, file) {
      applied.push(await readFile(file, "utf8"));
      await ops.applyFile(binding, file);
    },
    query: (binding, sql) => ops.query(binding, sql),
  };
}

const isFlip = (sql: string) =>
  sql.startsWith("UPDATE data_generation SET active");
const isClaim = (sql: string) =>
  sql.startsWith("UPDATE data_generation SET claim_slot =");

/** Dates the last flip `ms` ago. */
const setFlippedAgo = (ms: number) =>
  ops.query(
    "APP_DB",
    `UPDATE data_generation SET flipped_at = '${new Date(Date.now() - ms).toISOString()}' WHERE id = 1`,
  );
/** Dates the last flip just past the settle, so a claim needn't wait for it. */
const settleLastFlip = () => setFlippedAgo(FLIP_SETTLE_MS + 1_000);

const pointer = () =>
  ops.query<{ active: string; build_id: string }>(
    "APP_DB",
    "SELECT active, build_id FROM data_generation WHERE id = 1",
  );
const claimHolder = async () =>
  (
    await ops.query<{ claim_build_id: string | null }>(
      "APP_DB",
      "SELECT claim_build_id FROM data_generation WHERE id = 1",
    )
  )[0]?.claim_build_id;
const meta = (binding: "DATA_DB_A" | "DATA_DB_B") =>
  ops.query<{ slot: string; build_id: string; state: string }>(
    binding,
    READ_DATA_META_SQL,
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

  test("a first build, with no served counts to compare, is held to the table floors", async () => {
    await expect(
      run({ floors: { orgs: 1_000_000, filings: 1, programs: 1 } }),
    ).rejects.toThrow(
      /verify failed.*orgs floor \(orgs: \d+, floor 1000000\)/s,
    );

    expect(await pointer()).toStrictEqual([{ active: "a", build_id: "empty" }]);
    expect(await claimHolder()).toBeNull();
  });

  test("refresh builds the inactive slot and points the Worker at it", async () => {
    const report = await run({ via: recording(firstBuild) });

    expect(report).toMatchObject({ slot: "b", previous: "a" });
    expect(await pointer()).toStrictEqual([
      { active: "b", build_id: report.buildId },
    ]);
    expect(await meta("DATA_DB_B")).toStrictEqual([
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
    await settleLastFlip();
    const before = await pointer();
    const served = await ops.query("DATA_DB_B", RED_CROSS);

    // the first of the four BMF region files only: far fewer orgs than the generation served
    await expect(run({ bmf: ["eo1.csv"] })).rejects.toThrow(
      /verify failed.*orgs vs served \(orgs: \d+, served \d+\)/s,
    );

    expect(await pointer()).toStrictEqual(before);
    expect(await ops.query("DATA_DB_B", RED_CROSS)).toStrictEqual(served);
    expect(await meta("DATA_DB_A")).toMatchObject([
      { slot: "a", state: "building" },
    ]);
    expect(await claimHolder()).toBeNull();
  });

  test("rollback refuses a slot whose build never completed, naming the Time Travel restore", async () => {
    const before = await pointer();
    const [failed] = await meta("DATA_DB_A");

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
    expect(await meta("DATA_DB_A")).toStrictEqual([
      { slot: "b", build_id: "served", state: "building" },
    ]);
    expect(await claimHolder()).toBeNull();
  });

  test("a refresh refuses to start while another build holds the claim", async () => {
    await ops.query(
      "APP_DB",
      claimSlotSql("a", "elsewhere", new Date().toISOString()),
    );

    await expect(run()).rejects.toThrow("another build holds its claim");
    expect(await meta("DATA_DB_A")).toStrictEqual([
      { slot: "b", build_id: "served", state: "building" },
    ]);
    expect(await claimHolder()).toBe("elsewhere");
    await ops.query("APP_DB", releaseClaimSql("elsewhere"));
  });

  test("a claim whose answer is lost is released when the run fails", async () => {
    const lost = intercepting(async (sql) => {
      if (!isClaim(sql)) return undefined;
      await ops.query("APP_DB", sql);
      throw new Error("connection reset");
    });

    await expect(run({ via: lost })).rejects.toThrow("connection reset");
    expect(await claimHolder()).toBeNull();
  });

  test("a refresh claims the slot a flip left only once FLIP_SETTLE_MS (60 s) have passed", async () => {
    // A back to what a failed build leaves, for the refresh to take
    const failed = join(work, "failed-a.sql");
    await writeFile(failed, resetGenerationSql("a", "failed"));
    await ops.applyFile("DATA_DB_A", failed);
    // 10 s short of the settle, so the refresh has to wait those out
    const flippedAt = Date.now() - (FLIP_SETTLE_MS - 10_000);
    await setFlippedAgo(FLIP_SETTLE_MS - 10_000);
    let claimedAt: number | undefined;
    const timing = intercepting(async (sql) => {
      if (isClaim(sql)) claimedAt ??= Date.now();
      return undefined;
    });

    expect(await run({ via: timing })).toMatchObject({
      slot: "a",
      previous: "b",
    });
    expect((claimedAt ?? 0) - flippedAt).toBeGreaterThanOrEqual(FLIP_SETTLE_MS);
  });

  test("a rollback whose flip fails releases its claim and leaves the pointer", async () => {
    await settleLastFlip();
    const before = await pointer();
    const failing = intercepting(async (sql) => {
      if (isFlip(sql)) throw new Error("connection reset");
      return undefined;
    });

    await expect(rollback(failing)).rejects.toThrow(
      /flip failed: connection reset; the pointer serves slot a/,
    );
    expect(await pointer()).toStrictEqual(before);
    expect(await claimHolder()).toBeNull();
  });

  test("rollback flips back to the previous complete generation", async () => {
    const [b] = await meta("DATA_DB_B");

    expect(await rollback(ops)).toStrictEqual({
      from: "a",
      to: "b",
      buildId: b?.build_id,
    });
    expect(await pointer()).toStrictEqual([
      { active: "b", build_id: b?.build_id },
    ]);
  });

  test("a flip whose answer is lost still reports the build served", async () => {
    await settleLastFlip();
    const lost = intercepting(async (sql) => {
      if (!isFlip(sql)) return undefined;
      await ops.query("APP_DB", sql);
      throw new Error("connection reset");
    });

    const report = await run({ via: lost });

    expect(await pointer()).toStrictEqual([
      { active: "a", build_id: report.buildId },
    ]);
    expect(await claimHolder()).toBeNull();
  });

  test("a failed flip leaves the sealed build unserved, and rollback won't serve it", async () => {
    await settleLastFlip();
    const before = await pointer();
    let buildId: string | undefined;
    const failing = intercepting(async (sql) => {
      if (isFlip(sql)) {
        buildId = /build_id = '([^']+)'/.exec(sql)?.[1];
        throw new Error("connection reset");
      }
      return undefined;
    });

    await expect(run({ via: failing })).rejects.toThrow(
      /flip failed: connection reset; the pointer serves slot a/,
    );
    expect(await pointer()).toStrictEqual(before);
    expect(await claimHolder()).toBeNull();
    expect(await meta("DATA_DB_B")).toStrictEqual([
      { slot: "b", build_id: buildId, state: "complete" },
    ]);
    await expect(rollback(ops)).rejects.toThrow(
      `slot b's build ${buildId} was sealed`,
    );
    expect(await pointer()).toStrictEqual(before);
  });

  test("the flip fails when the pointer moved during the run", async () => {
    await settleLastFlip();
    const interloping = intercepting(async (sql) => {
      if (sql.startsWith("UPDATE data_meta SET state = 'complete'")) {
        // another run's flip lands first
        await ops.query(
          "APP_DB",
          "UPDATE data_generation SET active = 'b', build_id = 'elsewhere', claim_slot = NULL, claim_build_id = NULL, claimed_at = NULL, claim_expires_at = NULL WHERE id = 1",
        );
      }
      return undefined;
    });

    await expect(run({ via: interloping })).rejects.toThrow(
      "the pointer moved off slot a",
    );
    expect(await pointer()).toStrictEqual([
      { active: "b", build_id: "elsewhere" },
    ]);
  });

  test("release clears a stuck claim, only the named build's when one is named", async () => {
    await settleLastFlip();
    await ops.query(
      "APP_DB",
      claimSlotSql("a", "stuck", new Date().toISOString()),
    );

    expect(await releaseClaim(ops, "other")).toBeNull();
    expect(await claimHolder()).toBe("stuck");
    expect(await releaseClaim(ops)).toMatchObject({
      claim_slot: "a",
      claim_build_id: "stuck",
    });
    expect(await claimHolder()).toBeNull();
    expect(await releaseClaim(ops)).toBeNull();
  });

  test("a remote refresh refuses an e-file batch run before touching D1", async () => {
    const untouched: D1Ops = {
      remote: true,
      applyFile: () => Promise.reject(new Error("applied a file")),
      query: () => Promise.reject(new Error("ran a query")),
    };
    const partial = sources();
    partial.efile.batches = ["2026_TEOS_XML_03A"];

    await expect(
      refresh(untouched, {
        sources: partial,
        floors: FIXTURE_FLOORS,
        loadDir: join(work, "load"),
      }),
    ).rejects.toThrow("partial generation, which is local only");
  });
});
