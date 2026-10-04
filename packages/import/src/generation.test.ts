import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  claimSlotSql,
  DATA_DB_BINDING,
  FLIP_SETTLE_MS,
  flipActiveSlotSql,
  READ_DATA_META_SQL,
  releaseClaimSql,
  resetGenerationSql,
} from "@nonprofits/db";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  refresh,
  releaseAfterStop,
  releaseClaim,
  rollback,
  type TableFloors,
} from "./generation.ts";
import type { SourceConfig } from "./sources.ts";
import {
  type KeptClaim,
  type RunRecord,
  runRecord,
  summarized,
  summaryWriter,
} from "./summary.ts";
import {
  fixtureServer,
  fixtureSources,
  type FixtureList as List,
  migrateAppDb,
  sqliteWrangler,
} from "./test-support.ts";
import { type D1Ops, localD1, remoteD1 } from "./wrangler.ts";

const RED_CROSS =
  "SELECT o.name, f.mission FROM orgs o JOIN filings f ON f.ein = o.ein WHERE o.ein = '530196605'";

let server: Server;
let base: string;
let work: string;

/** The fixture sources: `bmf` region files only, and the cut route of each list in `cut`. */
function sources(bmf?: readonly string[], cut?: readonly List[]): SourceConfig {
  return fixtureSources(base, join(work, "efile"), bmf, cut);
}

/** Floors the fixtures clear. */
const FIXTURE_FLOORS: TableFloors = {
  orgs: 1,
  filings: 1,
  programs: 1,
  in_pub78: 1,
  revocation_date: 1,
  files_990n: 1,
  bmf_run_id: 1,
};

/** What a build of the fixtures counts: floors at these clear, a floor one above fails. */
const FIXTURE_COUNTS: TableFloors = {
  orgs: 260,
  filings: 10,
  programs: 19,
  // the distinct EINs of each fixture: 122 in Pub 78, 26 revoked, 95 990-N filers, 245 in the BMF
  in_pub78: 122,
  revocation_date: 26,
  files_990n: 95,
  bmf_run_id: 245,
};

const RED_CROSS_EIN = "530196605";
const FIRST_BUILD_CHECKS = [
  "slot",
  "orgs floor",
  "filings floor",
  "programs floor",
  "in_pub78 floor",
  "revocation_date floor",
  "files_990n floor",
  "bmf_run_id floor",
  "red cross",
  "red cross deductible",
  "search index",
  "null eins",
];
/** A build with a served one to compare with adds a `vs served` check after each floor. */
const LATER_BUILD_CHECKS = [
  "slot",
  ...Object.keys(FIXTURE_COUNTS).flatMap((name) => [
    `${name} floor`,
    `${name} vs served`,
  ]),
  "red cross",
  "red cross deductible",
  "search index",
  "null eins",
];

interface RunOptions {
  bmf?: readonly string[];
  cut?: readonly List[];
  floors?: TableFloors;
  via?: D1Ops;
  log?: (line: string) => void;
  onClaim?: (buildId: string) => void;
  forceVerifyFailure?: boolean;
  record?: RunRecord;
}

/**
 * A pair of data databases and an app database of its own, in memory, so no
 * test reads what another left; `wrangler d1 execute` is the only thing
 * replaced, and `localD1` still builds every command and reads every answer.
 */
function world() {
  const run = sqliteWrangler();
  const ops = localD1(undefined, { run });
  const query = <T>(binding: Parameters<D1Ops["query"]>[0], sql: string) =>
    ops.query<T>(binding, sql);
  return {
    ops,
    query,
    refresh: (options: RunOptions = {}) =>
      refresh(options.via ?? ops, {
        sources: sources(options.bmf, options.cut),
        floors: options.floors ?? FIXTURE_FLOORS,
        loadDir: join(work, "load"),
        log: options.log ?? (() => {}),
        ...(options.onClaim === undefined ? {} : { onClaim: options.onClaim }),
        ...(options.forceVerifyFailure === undefined
          ? {}
          : { forceVerifyFailure: options.forceVerifyFailure }),
        ...(options.record === undefined ? {} : { record: options.record }),
      }),
    /** `remoteD1`, each `--file` failing with `failure`; every other command runs on this world. */
    failingApply: (failure: string) =>
      remoteD1({
        run: (args, timeoutMs) =>
          args.includes("--file")
            ? Promise.reject(new Error(failure))
            : run(args, timeoutMs),
      }),
    pointer: () =>
      query<{ active: string; build_id: string }>(
        "APP_DB",
        "SELECT active, build_id FROM data_generation WHERE id = 1",
      ),
    claimHolder: async () =>
      (
        await query<{ claim_build_id: string | null }>(
          "APP_DB",
          "SELECT claim_build_id FROM data_generation WHERE id = 1",
        )
      )[0]?.claim_build_id,
    meta: (binding: "DATA_DB_A" | "DATA_DB_B") =>
      query<{ slot: string; build_id: string; state: string }>(
        binding,
        READ_DATA_META_SQL,
      ),
    /** Dates the last flip `ms` ago. */
    flippedAgo: (ms: number) =>
      query(
        "APP_DB",
        `UPDATE data_generation SET flipped_at = '${new Date(Date.now() - ms).toISOString()}' WHERE id = 1`,
      ),
  };
}
type World = ReturnType<typeof world>;

/** Dates the last flip just past the settle, so a claim needn't wait for it. */
const settled = (w: World) => w.flippedAgo(FLIP_SETTLE_MS + 1_000);

/** A world serving its first build, in slot b, past the settle. */
async function servingFirstBuild(): Promise<World> {
  const w = world();
  await w.refresh();
  await settled(w);
  return w;
}

/** Slot `slot` holding a complete build "old" sealed in 2000, the pointer last moved the day after: a generation rollback may serve. */
async function holdPreviousBuild(w: World, slot: "a" | "b"): Promise<void> {
  const file = join(work, `reset-${slot}.sql`);
  await writeFile(file, resetGenerationSql(slot, "old"));
  await w.ops.applyFile(DATA_DB_BINDING[slot], file);
  await w.query(
    DATA_DB_BINDING[slot],
    "UPDATE data_meta SET state = 'complete', built_at = '2000-01-01T00:00:00Z' WHERE id = 1",
  );
  await w.query(
    "APP_DB",
    "UPDATE data_generation SET flipped_at = '2000-01-02T00:00:00Z' WHERE id = 1",
  );
}

/** `w`'s ops, but `onQuery` sees each query first and may answer it instead. */
function intercepting(
  w: World,
  onQuery: (sql: string) => Promise<unknown[] | undefined>,
): D1Ops {
  return {
    remote: false,
    applyFile: (binding, file) => w.ops.applyFile(binding, file),
    async query<T>(binding: Parameters<D1Ops["query"]>[0], sql: string) {
      const answer = await onQuery(sql);
      return (answer as T[] | undefined) ?? w.ops.query<T>(binding, sql);
    },
  };
}

/** `w`'s ops, keeping the text of every SQL file it applies in `applied`. */
function recording(w: World, applied: string[]): D1Ops {
  return {
    remote: false,
    async applyFile(binding, file) {
      applied.push(await readFile(file, "utf8"));
      await w.ops.applyFile(binding, file);
    },
    query: (binding, sql) => w.ops.query(binding, sql),
  };
}

/** `w`'s ops, each of `statements` run on `binding` once the search index is rebuilt: the last step before verify reads the build. */
function corruptingBeforeVerify(
  w: World,
  binding: "DATA_DB_A" | "DATA_DB_B",
  statements: readonly string[],
): D1Ops {
  return {
    remote: false,
    async applyFile(applied, file) {
      await w.ops.applyFile(applied, file);
      if (basename(file) === "search-index.sql") {
        for (const sql of statements) await w.query(binding, sql);
      }
    },
    query: (target, sql) => w.ops.query(target, sql),
  };
}

const isFlip = (sql: string) =>
  sql.startsWith("UPDATE data_generation SET active");
const isClaim = (sql: string) =>
  sql.startsWith("UPDATE data_generation SET claim_slot = '");

beforeAll(async () => {
  ({ server, base } = await fixtureServer());
  work = await mkdtemp(join(tmpdir(), "generation-"));
}, 60_000);

afterAll(async () => {
  server?.close();
  if (work) await rm(work, { recursive: true, force: true });
});

const COUNT_NAMES = Object.keys(FIXTURE_COUNTS) as (keyof TableFloors)[];

describe("refresh and rollback", { timeout: 30_000 }, () => {
  // a build's id is its start time to the second: a test's later builds start later
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const startLater = () => vi.setSystemTime(Date.now() + 2_000);

  test("a first build, held to floors equal to its counts, is served", async () => {
    const w = world();

    const report = await w.refresh({ floors: FIXTURE_COUNTS });

    expect(report).toMatchObject({
      slot: "b",
      previous: "a",
      counts: FIXTURE_COUNTS,
    });
    expect(report.checks.map((c) => [c.name, c.ok])).toStrictEqual(
      FIRST_BUILD_CHECKS.map((name) => [name, true]),
    );
    expect(await w.pointer()).toStrictEqual([
      { active: "b", build_id: report.buildId },
    ]);
    expect(await w.meta("DATA_DB_B")).toStrictEqual([
      { slot: "b", build_id: report.buildId, state: "complete" },
    ]);
    expect(await w.query("DATA_DB_B", RED_CROSS)).toStrictEqual([
      {
        name: "AMERICAN NATIONAL RED CROSS",
        mission:
          "THE AMERICAN RED CROSS PREVENTS AND ALLEVIATES HUMAN SUFFERING IN THE FACE OF EMERGENCIES BY MOBILIZING THE POWER OF VOLUNTEERS AND THE GENEROSITY OF DONORS.",
      },
    ]);
    expect(
      await w.query(
        "DATA_DB_A",
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ),
    ).toStrictEqual([]);
    expect(await w.claimHolder()).toBeNull();
  });

  test("a build with a served one to compare with adds a vs-served check after each floor", async () => {
    const w = await servingFirstBuild();
    startLater();

    const report = await w.refresh({ floors: FIXTURE_COUNTS });

    expect(report.checks.map((c) => [c.name, c.ok])).toStrictEqual(
      LATER_BUILD_CHECKS.map((name) => [name, true]),
    );
    expect(await w.pointer()).toStrictEqual([
      { active: "a", build_id: report.buildId },
    ]);
  });

  test.each(COUNT_NAMES)(
    "a first build with a floor one above its %s count fails verify, leaving the pointer",
    async (name) => {
      const w = world();
      const floor = FIXTURE_COUNTS[name] + 1;

      await expect(
        w.refresh({ floors: { ...FIXTURE_COUNTS, [name]: floor } }),
      ).rejects.toThrow(
        `${name} floor (${name}: ${FIXTURE_COUNTS[name]}, floor ${floor})`,
      );

      expect(await w.pointer()).toStrictEqual([
        { active: "a", build_id: "empty" },
      ]);
      expect(await w.claimHolder()).toBeNull();
    },
  );

  test("a refresh rebuilds the search index once, over every source's names", async () => {
    const w = world();
    const applied: string[] = [];

    await w.refresh({ via: recording(w, applied) });

    expect(
      applied.flatMap((sql) => sql.match(/'delete-all'/g) ?? []),
    ).toHaveLength(1);
    for (const [words, rowid] of [
      ["red cross", 530196605],
      // named only by Pub 78 and the revocation list
      ["fundraising professionals", 999999010],
      ["green valley", 10281533],
    ] as const) {
      expect(
        await w.query(
          "DATA_DB_B",
          `SELECT rowid FROM orgs_fts WHERE orgs_fts MATCH '${words}'`,
        ),
      ).toStrictEqual([{ rowid }]);
    }
  });

  const PHANTOM_INDEX_ROW =
    "INSERT INTO orgs_fts (rowid, name) VALUES (1, 'phantom')";
  const UNINDEXED_ORG =
    "INSERT INTO orgs (ein, name, name_run_id) VALUES ('999999901', 'NOT INDEXED', (SELECT min(id) FROM import_runs))";
  const ON_RED_CROSS = `ein = '${RED_CROSS_EIN}'`;
  // one corrupted thing each: verify names that check and no other
  test.each([
    {
      name: "a data_meta naming another build",
      statements: ["UPDATE data_meta SET build_id = 'someone-else'"],
      failed: () =>
        "slot (DATA_DB_B says slot b, build someone-else, building)",
    },
    {
      name: "a data_meta naming the other slot",
      statements: ["UPDATE data_meta SET slot = 'a'"],
      failed: (id: string) =>
        `slot (DATA_DB_B says slot a, build ${id}, building)`,
    },
    {
      name: "a data_meta already sealed",
      statements: ["UPDATE data_meta SET state = 'complete'"],
      failed: (id: string) =>
        `slot (DATA_DB_B says slot b, build ${id}, complete)`,
    },
    {
      name: "a Red Cross filing without a mission",
      statements: [`UPDATE filings SET mission = NULL WHERE ${ON_RED_CROSS}`],
      failed: () => `red cross (${RED_CROSS_EIN} has no filing with a mission)`,
    },
    {
      name: "a Red Cross mission of whitespace",
      statements: [`UPDATE filings SET mission = '  ' WHERE ${ON_RED_CROSS}`],
      failed: () => `red cross (${RED_CROSS_EIN} has no filing with a mission)`,
    },
    {
      name: "no Red Cross filing",
      statements: [
        `DELETE FROM programs WHERE ${ON_RED_CROSS}`,
        `DELETE FROM filings WHERE ${ON_RED_CROSS}`,
      ],
      failed: () => `red cross (${RED_CROSS_EIN} has no filing with a mission)`,
    },
    {
      name: "the Red Cross not in Pub 78",
      statements: [`UPDATE orgs SET in_pub78 = 0 WHERE ${ON_RED_CROSS}`],
      failed: () => `red cross deductible (${RED_CROSS_EIN} is not in Pub 78)`,
    },
    {
      name: "an index row for no named org",
      statements: [PHANTOM_INDEX_ROW],
      failed: () => "search index (250 index rows, 249 named orgs)",
    },
    {
      name: "a named org missing from the index",
      statements: [UNINDEXED_ORG],
      failed: () => "search index (249 index rows, 250 named orgs)",
    },
  ])(
    "a build with $name fails verify on that check alone, leaving the pointer and the claim",
    async ({ statements, failed }) => {
      const w = world();
      let buildId = "";

      const error = await w
        .refresh({
          via: corruptingBeforeVerify(w, "DATA_DB_B", statements),
          onClaim: (id) => {
            buildId = id;
          },
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        `verify failed for build ${buildId} in DATA_DB_B: ${failed(buildId)}`,
      );
      expect(await w.pointer()).toStrictEqual([
        { active: "a", build_id: "empty" },
      ]);
      expect(await w.claimHolder()).toBeNull();
    },
  );

  test("the null eins check cannot fail: the data tables refuse a null ein", async () => {
    const w = world();
    const reset = join(work, "reset-null-ein.sql");
    await writeFile(reset, resetGenerationSql("b", "building"));
    await w.ops.applyFile("DATA_DB_B", reset);

    for (const sql of [
      "INSERT INTO orgs (ein) VALUES (NULL)",
      "INSERT INTO filings (ein, object_id, form_type, tax_period, tax_year, run_id) VALUES (NULL, '1', '990', '2025-01', 2024, 1)",
      "INSERT INTO programs (ein, object_id, rank) VALUES (NULL, '1', 1)",
    ]) {
      await expect(w.query("DATA_DB_B", sql)).rejects.toThrow(
        /NOT NULL constraint failed: \w+\.ein/,
      );
    }
  });

  // the served build counts 260 orgs, 10 filings and 19 programs: 10% is 26, 1 and 1.9
  const addOrgs = (n: number) =>
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n}) INSERT INTO orgs (ein) SELECT printf('9999%05d', i) FROM n`;
  const dropPrograms = (n: number) =>
    `DELETE FROM programs WHERE rowid IN (SELECT rowid FROM programs ORDER BY rowid LIMIT ${n})`;
  const dropPfFilings = (n: number) =>
    `DELETE FROM filings WHERE object_id IN (SELECT object_id FROM filings WHERE form_type = '990-PF' ORDER BY object_id LIMIT ${n})`;

  test.each([
    {
      name: "orgs 10% above",
      statements: [addOrgs(26)],
      count: "orgs",
      n: 286,
    },
    {
      name: "programs 1 below (5.3%)",
      statements: [dropPrograms(1)],
      count: "programs",
      n: 18,
    },
    {
      name: "filings 1 below (10%)",
      statements: [dropPfFilings(1)],
      count: "filings",
      n: 9,
    },
  ] as const)(
    "a build whose $name the served one is within tolerance and is served",
    async ({ statements, count, n }) => {
      const w = await servingFirstBuild();
      startLater();

      const report = await w.refresh({
        via: corruptingBeforeVerify(w, "DATA_DB_A", statements),
      });

      expect(report.counts[count]).toBe(n);
      expect(await w.pointer()).toStrictEqual([
        { active: "a", build_id: report.buildId },
      ]);
    },
  );

  test.each([
    {
      name: "orgs 10.4% above",
      statements: [addOrgs(27)],
      failed: "orgs vs served (orgs: 287, served 260)",
    },
    {
      name: "programs 2 below (10.5%)",
      statements: [dropPrograms(2)],
      failed: "programs vs served (programs: 17, served 19)",
    },
    {
      name: "filings 2 below (20%)",
      statements: [dropPfFilings(2)],
      failed: "filings vs served (filings: 8, served 10)",
    },
  ])(
    "a build whose $name the served one fails verify on that check alone, leaving the pointer",
    async ({ statements, failed }) => {
      const w = await servingFirstBuild();
      const served = await w.pointer();
      startLater();
      let buildId = "";

      const error = await w
        .refresh({
          via: corruptingBeforeVerify(w, "DATA_DB_A", statements),
          onClaim: (id) => {
            buildId = id;
          },
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        `verify failed for build ${buildId} in DATA_DB_A: ${failed}`,
      );
      expect(await w.pointer()).toStrictEqual(served);
      expect(await w.claimHolder()).toBeNull();
    },
  );

  test("a refresh that fails verify leaves the pointer and the served Red Cross unchanged", async () => {
    const w = await servingFirstBuild();
    const before = await w.pointer();
    const served = await w.query("DATA_DB_B", RED_CROSS);
    startLater();

    // the first of the four BMF region files only: far fewer orgs than the generation served
    await expect(w.refresh({ bmf: ["eo1.csv"] })).rejects.toThrow(
      /verify failed.*orgs vs served \(orgs: \d+, served \d+\)/s,
    );

    expect(await w.pointer()).toStrictEqual(before);
    expect(await w.query("DATA_DB_B", RED_CROSS)).toStrictEqual(served);
    expect(await w.meta("DATA_DB_A")).toMatchObject([
      { slot: "a", state: "building" },
    ]);
    expect(await w.claimHolder()).toBeNull();
  });

  test("a forced verify failure fails a build that passes every real check, after the full load, and leaves the served build", async () => {
    const w = await servingFirstBuild();
    const before = await w.pointer();
    const served = await w.query("DATA_DB_B", RED_CROSS);
    startLater();
    const lines: string[] = [];

    const error = await w
      .refresh({ forceVerifyFailure: true, log: (line) => lines.push(line) })
      .catch((e: unknown) => String(e));

    expect(error).toMatch(
      /verify failed for build \S+ in DATA_DB_A: forced failure \(--force-verify-failure was given\)$/,
    );
    // every real check ran on the full build, and passed
    expect(lines.filter((line) => line.startsWith("check "))).toHaveLength(
      LATER_BUILD_CHECKS.length + 1,
    );
    expect(lines.filter((line) => line.includes(": FAILED,"))).toStrictEqual([
      expect.stringMatching(/^check forced failure: FAILED, /),
    ]);
    expect(await w.pointer()).toStrictEqual(before);
    expect(await w.query("DATA_DB_B", RED_CROSS)).toStrictEqual(served);
    expect(await w.query("DATA_DB_A", RED_CROSS)).toStrictEqual(served);
    expect(await w.meta("DATA_DB_A")).toMatchObject([
      { slot: "a", state: "building" },
    ]);
    expect(await w.claimHolder()).toBeNull();
  });

  test("a refresh whose list facts landed on more than 10% fewer orgs than served fails verify, and so does a Red Cross not deductible", async () => {
    const w = await servingFirstBuild();
    const before = await w.pointer();
    startLater();

    const error = await w
      .refresh({
        bmf: ["eo1.csv"],
        cut: ["pub78", "revocation", "epostcard"],
      })
      .catch((e: unknown) => String(e));

    // the cut lists' and eo1.csv's distinct EINs, against the full fixtures'
    for (const failed of [
      "in_pub78 vs served (in_pub78: 60, served 122)",
      "revocation_date vs served (revocation_date: 10, served 26)",
      "files_990n vs served (files_990n: 50, served 95)",
      "bmf_run_id vs served (bmf_run_id: 62, served 245)",
      "red cross deductible (530196605 is not in Pub 78)",
    ]) {
      expect(error).toContain(failed);
    }
    expect(await w.pointer()).toStrictEqual(before);
    expect(await w.claimHolder()).toBeNull();
  });

  test("rollback refuses a slot whose build never completed, naming the Time Travel restore", async () => {
    const w = await servingFirstBuild();
    startLater();
    await expect(
      w.refresh({ floors: { ...FIXTURE_FLOORS, orgs: 1e6 } }),
    ).rejects.toThrow("verify failed");
    const before = await w.pointer();
    const [failed] = await w.meta("DATA_DB_A");

    await expect(rollback(w.ops)).rejects.toThrow(
      `wrangler d1 time-travel restore DATA_DB_A --timestamp=${failed?.build_id}`,
    );
    expect(await w.pointer()).toStrictEqual(before);
  });

  test("a refresh refuses to reset a database whose data_meta names the served slot", async () => {
    const w = world();
    // DATA_DB_B wired to the served database would read like this
    const imposter = join(work, "imposter.sql");
    await writeFile(imposter, resetGenerationSql("a", "served"));
    await w.ops.applyFile("DATA_DB_B", imposter);

    await expect(w.refresh()).rejects.toThrow(
      "DATA_DB_B holds slot a's generation",
    );
    expect(await w.pointer()).toStrictEqual([
      { active: "a", build_id: "empty" },
    ]);
    expect(await w.meta("DATA_DB_B")).toStrictEqual([
      { slot: "a", build_id: "served", state: "building" },
    ]);
    expect(await w.claimHolder()).toBeNull();
  });

  test("a refresh refuses to start while another build holds the claim", async () => {
    const w = world();
    await w.query("APP_DB", claimSlotSql("b", "elsewhere"));

    await expect(w.refresh()).rejects.toThrow("another build holds its claim");
    expect(
      await w.query("DATA_DB_B", "SELECT name FROM sqlite_master"),
    ).toStrictEqual([]);
    expect(await w.claimHolder()).toBe("elsewhere");
  });

  test("a claim whose answer is lost is released when the run fails", async () => {
    const w = world();
    const lost = intercepting(w, async (sql) => {
      if (!isClaim(sql)) return undefined;
      await w.ops.query("APP_DB", sql);
      throw new Error("connection reset");
    });

    await expect(w.refresh({ via: lost })).rejects.toThrow("connection reset");
    expect(await w.claimHolder()).toBeNull();
  });

  test.each([
    ["timed out", "wrangler d1 execute timed out after 7200000 ms"],
    ["was stopped", "wrangler d1 execute stopped"],
    [
      "lost its polling",
      "wrangler d1 execute failed:\n✘ [ERROR] A request to the Cloudflare API (/accounts/x/d1/database/y/import) failed.",
    ],
  ])(
    "a remote refresh whose apply %s keeps its claim, naming the release for once the import stops",
    async (_, failure) => {
      const w = world();
      const lines: string[] = [];

      await expect(
        w.refresh({ via: w.failingApply(failure), log: (l) => lines.push(l) }),
      ).rejects.toThrow(failure.split("\n")[0]);
      const held = await w.claimHolder();

      expect(held).not.toBeNull();
      expect(lines.at(-1)).toMatch(
        new RegExp(
          `^build ${held} keeps its claim: DATA_DB_[AB]'s import may still be running in D1, which serves that database no queries until it ends; once it has, irs release --remote --build ${held} clears the claim$`,
        ),
      );
    },
  );

  test("a remote refresh whose import reported its own failure releases its claim", async () => {
    const w = world();
    const failure =
      "wrangler d1 execute failed:\n✘ [ERROR] UNIQUE constraint failed: orgs.ein: SQLITE_CONSTRAINT";

    await expect(w.refresh({ via: w.failingApply(failure) })).rejects.toThrow(
      "UNIQUE constraint failed",
    );
    expect(await w.claimHolder()).toBeNull();
  });

  describe("after a flip, the slot it left", () => {
    /** Starts `command` into a pointer flipped `ago` ms ago, stopping it at its claim; resolves with when it got there and what it logged. */
    async function untilClaim(
      command: "refresh" | "rollback",
      ago: number,
      advance: readonly number[],
    ): Promise<{ claimsAfter: number[]; lines: string[] }> {
      const w = world();
      if (command === "rollback") await holdPreviousBuild(w, "b");
      vi.useFakeTimers({
        toFake: ["Date", "setTimeout", "clearTimeout"],
        now: Date.now(),
      });
      await w.flippedAgo(ago);
      const lines: string[] = [];
      let claims = 0;
      const via = intercepting(w, async (sql) => {
        if (!isClaim(sql)) return undefined;
        claims++;
        throw new Error("stopped at the claim");
      });
      const log = (line: string) => lines.push(line);
      const started =
        command === "refresh"
          ? w.refresh({ via, log })
          : rollback(via, { log });
      const stopped = expect(started).rejects.toThrow("stopped at the claim");
      const claimsAfter: number[] = [];
      await vi.advanceTimersByTimeAsync(0);
      for (const ms of advance) {
        await vi.advanceTimersByTimeAsync(ms);
        claimsAfter.push(claims);
      }
      await stopped;
      return { claimsAfter, lines };
    }

    test.each(["refresh", "rollback"] as const)(
      "is claimed by a %s only once FLIP_SETTLE_MS (60 s) have passed",
      async (command) => {
        // 10 s short of the settle
        const { claimsAfter, lines } = await untilClaim(
          command,
          FLIP_SETTLE_MS - 10_000,
          [9_999, 1],
        );

        expect(claimsAfter).toStrictEqual([0, 1]);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(
          /^waiting 10 s: the flip at \S+ left slot b, and Workers may still serve it$/,
        );
      },
    );

    test("is claimed at once when the settle just ended", async () => {
      const { claimsAfter, lines } = await untilClaim(
        "refresh",
        FLIP_SETTLE_MS,
        [0],
      );

      expect(claimsAfter).toStrictEqual([1]);
      expect(lines.filter((line) => line.startsWith("waiting"))).toStrictEqual(
        [],
      );
    });

    test("is waited out for the last millisecond", async () => {
      const { claimsAfter, lines } = await untilClaim(
        "refresh",
        FLIP_SETTLE_MS - 1,
        [0, 1],
      );

      expect(claimsAfter).toStrictEqual([0, 1]);
      expect(lines[0]).toMatch(/^waiting 1 s: /);
    });
  });

  test("a rollback whose flip fails releases its claim and leaves the pointer", async () => {
    const w = world();
    await holdPreviousBuild(w, "b");
    const before = await w.pointer();
    const failing = intercepting(w, async (sql) => {
      if (isFlip(sql)) throw new Error("connection reset");
      return undefined;
    });

    await expect(rollback(failing)).rejects.toThrow(
      /flip failed: connection reset; the pointer serves slot a/,
    );
    expect(await w.pointer()).toStrictEqual(before);
    expect(await w.claimHolder()).toBeNull();
  });

  test("rollback flips back to the previous complete generation", async () => {
    const w = world();
    await holdPreviousBuild(w, "b");

    expect(await rollback(w.ops)).toStrictEqual({
      from: "a",
      to: "b",
      buildId: "old",
    });
    expect(await w.pointer()).toStrictEqual([{ active: "b", build_id: "old" }]);
  });

  test("a flip whose answer is lost still reports the build served", async () => {
    const w = world();
    const lost = intercepting(w, async (sql) => {
      if (!isFlip(sql)) return undefined;
      await w.ops.query("APP_DB", sql);
      throw new Error("connection reset");
    });

    const report = await w.refresh({ via: lost });

    expect(await w.pointer()).toStrictEqual([
      { active: "b", build_id: report.buildId },
    ]);
    expect(await w.claimHolder()).toBeNull();
  });

  test("a failed flip leaves the sealed build unserved, and rollback won't serve it", async () => {
    const w = world();
    const before = await w.pointer();
    let buildId: string | undefined;
    const failing = intercepting(w, async (sql) => {
      if (isFlip(sql)) {
        buildId = /build_id = '([^']+)'/.exec(sql)?.[1];
        throw new Error("connection reset");
      }
      return undefined;
    });

    await expect(w.refresh({ via: failing })).rejects.toThrow(
      /flip failed: connection reset; the pointer serves slot a/,
    );
    expect(await w.pointer()).toStrictEqual(before);
    expect(await w.claimHolder()).toBeNull();
    expect(await w.meta("DATA_DB_B")).toStrictEqual([
      { slot: "b", build_id: buildId, state: "complete" },
    ]);
    await expect(rollback(w.ops)).rejects.toThrow(
      `slot b's build ${buildId} was sealed`,
    );
    expect(await w.pointer()).toStrictEqual(before);
  });

  test("the flip fails when the pointer moved during the run", async () => {
    const w = world();
    const interloping = intercepting(w, async (sql) => {
      if (sql.startsWith("UPDATE data_meta SET state = 'complete'")) {
        // another run's flip lands first
        await w.ops.query(
          "APP_DB",
          "UPDATE data_generation SET active = 'b', build_id = 'elsewhere', claim_slot = NULL, claim_build_id = NULL, claimed_at = NULL, claim_expires_at = NULL WHERE id = 1",
        );
      }
      return undefined;
    });

    await expect(w.refresh({ via: interloping })).rejects.toThrow(
      "the pointer moved off slot a",
    );
    expect(await w.pointer()).toStrictEqual([
      { active: "b", build_id: "elsewhere" },
    ]);
  });

  test("release clears a stuck claim, only the named build's when one is named", async () => {
    const w = world();
    await w.query("APP_DB", claimSlotSql("b", "stuck"));

    expect(await releaseClaim(w.ops, "other")).toBeNull();
    expect(await w.claimHolder()).toBe("stuck");
    expect(await releaseClaim(w.ops)).toMatchObject({
      claim_slot: "b",
      claim_build_id: "stuck",
    });
    expect(await w.claimHolder()).toBeNull();
    expect(await releaseClaim(w.ops)).toBeNull();
  });

  test.each([
    [
      "keeps a claim when the stop killed a remote import, naming the database it may still be running in",
      true,
      [],
      [{ buildId: "stopped", binding: "DATA_DB_B" }],
      "stopped",
    ],
    [
      "releases a claim when the stop killed no import",
      false,
      ["released build stopped's claim"],
      [],
      null,
    ],
  ])("after a stop, %s", async (_, importKilled, reported, kept, held) => {
    const w = world();
    await w.query("APP_DB", claimSlotSql("b", "stopped"));
    const killed = importKilled
      ? [["d1", "execute", "DATA_DB_B", "--remote", "--yes", "--file", "x.sql"]]
      : [
          [
            "d1",
            "execute",
            "APP_DB",
            "--remote",
            "--yes",
            "--json",
            "--command",
            "SELECT 1",
          ],
        ];
    const lines: string[] = [];
    const keptClaims: KeptClaim[] = [];

    await releaseAfterStop(
      w.failingApply("no file is applied"),
      ["stopped"],
      killed,
      {
        report: (line) => lines.push(line),
        keep: (claim) => keptClaims.push(claim),
      },
    );

    expect(lines.slice(0, -1)).toStrictEqual(reported);
    expect(lines.at(-1)).toMatch(/^serving slot [ab] \(build \S+\)$/);
    expect(keptClaims).toStrictEqual(kept);
    expect(await w.claimHolder()).toBe(held);
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

describe("run summary", { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const startLater = () => vi.setSystemTime(Date.now() + 2_000);
  let n = 0;
  const summaryFile = () => join(work, `summary-${++n}.md`);
  /** A markdown table row of `cells`, as the summary writes one. */
  const row = (...cells: string[]) => `| ${cells.join(" | ")} |`;

  test("a served refresh's summary lists each source's rows, the e-file years and yields, every check with its numbers, each step's time, and the build served before and after", async () => {
    const w = await servingFirstBuild();
    const [before] = await w.pointer();
    startLater();
    const record = runRecord("refresh", false);
    const file = summaryFile();

    const report = await summarized(
      w.ops,
      record,
      summaryWriter(file, []),
      () => w.refresh({ record }),
    );

    const md = await readFile(file, "utf8");
    expect(md).toContain(
      `## irs refresh (local D1): serving slot a, build ${report.buildId}\n`,
    );
    expect(md).toContain(row("served before", "b", `${before?.build_id}`));
    expect(md).toContain(row("served after", "a", report.buildId));
    // the fixtures' data rows: eo1–eo4.csv's 62 + 61 + 60 + 62, each list's lines that open with an EIN, the 10 latest filings
    const released = "2026-09-16T13:02:21.000Z";
    expect(md).toContain(row("bmf", "245 orgs", released));
    expect(md).toContain(row("pub78", "122 rows", released));
    expect(md).toContain(row("revocation", "31 rows", released));
    expect(md).toContain(row("epostcard", "95 rows", released));
    expect(md).toContain(
      row(
        "efile",
        "10 filings",
        `2026: ${released}, 2025: ${released}, 2024: ${released}`,
      ),
    );
    expect(md).toContain(
      "Release years read: 2026, 2025, 2024 (index_2026.csv lists 11 rows, at least half of index_2025.csv's 3: 3 release years read)",
    );
    expect(md).toContain(
      row("990", "7 returns", "100.0% with mission, 100.0% with revenue"),
    );
    expect(md).toContain(
      row("990-EZ", "1 returns", "100.0% with mission, 100.0% with finances"),
    );
    expect(md).toContain(row("990-PF", "2 returns", "100.0% with finances"));
    for (const name of LATER_BUILD_CHECKS) {
      expect(md).toMatch(
        new RegExp(`^\\| ${name} \\| ok \\| .+ \\| \\d+\\.\\d s \\|$`, "m"),
      );
    }
    expect(md).toContain(row("orgs floor", "ok", "orgs: 260, floor 1"));
    expect(md).toContain(row("orgs vs served", "ok", "orgs: 260, served 260"));
    for (const step of [
      "claimed slot a",
      "reset DATA_DB_A",
      "loaded bmf",
      "loaded pub78",
      "loaded revocation",
      "loaded epostcard",
      "loaded efile",
      "rebuilt the search index",
      "verified",
      "sealed",
      "flipped to slot a",
      "total",
    ]) {
      expect(md).toMatch(new RegExp(`^\\| ${step} \\| \\d+\\.\\d s \\|$`, "m"));
    }
    expect(md).not.toContain("**Failed:**");
  });

  test("a failed refresh's summary carries the failure on one line, the failed check with the rest, and the build still served", async () => {
    const w = await servingFirstBuild();
    const [before] = await w.pointer();
    startLater();
    const record = runRecord("refresh", false);
    const file = summaryFile();

    const error = await summarized(w.ops, record, summaryWriter(file, []), () =>
      w.refresh({ record, forceVerifyFailure: true }),
    ).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));

    const md = await readFile(file, "utf8");
    expect(md).toContain("## irs refresh (local D1): failed\n");
    expect(
      md.split("\n").filter((l) => l.startsWith("**Failed:**")),
    ).toStrictEqual([`**Failed:** ${error}`]);
    expect(error).toContain(
      "forced failure (--force-verify-failure was given)",
    );
    expect(md).toContain(
      row("forced failure", "FAILED", "--force-verify-failure was given"),
    );
    expect(md).toContain(row("orgs vs served", "ok", "orgs: 260, served 260"));
    expect(md).toContain(row("served before", "b", `${before?.build_id}`));
    expect(md).toContain(row("served after", "b", `${before?.build_id}`));
    expect(md).toMatch(/^\| verified \| failed after \d+\.\d s \|$/m);
  });

  test("a summary never carries a secret, and an empty or missing one in the list leaves the text unmangled", async () => {
    const w = world();
    const record = runRecord("refresh", true);
    const file = summaryFile();

    await expect(
      summarized(
        w.ops,
        record,
        summaryWriter(file, ["0123abcd", "", undefined]),
        () =>
          w.refresh({
            record,
            via: w.failingApply(
              "A request to the Cloudflare API (/accounts/0123abcd/d1/database/x/import) failed.",
            ),
          }),
      ),
    ).rejects.toThrow("0123abcd");

    const md = await readFile(file, "utf8");
    expect(md).toContain(
      "**Failed:** A request to the Cloudflare API (/accounts/[redacted]/d1/database/x/import) failed.\n",
    );
    expect(md).not.toContain("0123abcd");
    expect(md).toMatch(/^\| reset DATA_DB_B \| failed after \d+\.\d s \|$/m);
  });

  test("a refresh that keeps its claim says so in its summary, naming the release for once the import ends", async () => {
    const w = world();
    const record = runRecord("refresh", true);
    const file = summaryFile();

    await expect(
      summarized(w.ops, record, summaryWriter(file, []), () =>
        w.refresh({
          record,
          via: w.failingApply("wrangler d1 execute timed out after 7200000 ms"),
        }),
      ),
    ).rejects.toThrow("timed out");

    const held = await w.claimHolder();
    const md = await readFile(file, "utf8");
    expect(
      md.split("\n").filter((l) => l.startsWith("**Claim kept:**")),
    ).toStrictEqual([
      `**Claim kept:** build ${held} keeps its claim: DATA_DB_B's import may still be running in D1, which serves that database no queries until it ends; once it has, irs release --remote --build ${held} clears the claim`,
    ]);
  });

  test("a rollback's summary names the build served before and after", async () => {
    const w = world();
    await holdPreviousBuild(w, "b");
    const record = runRecord("rollback", false);
    const file = summaryFile();

    await summarized(w.ops, record, summaryWriter(file, []), () =>
      rollback(w.ops, { record }),
    );

    const md = await readFile(file, "utf8");
    expect(md).toContain(
      "## irs rollback (local D1): serving slot b, build old\n",
    );
    expect(md).toContain(row("served before", "a", "empty"));
    expect(md).toContain(row("served after", "b", "old"));
    for (const step of ["claimed slot b", "flipped to slot b", "total"]) {
      expect(md).toMatch(new RegExp(`^\\| ${step} \\| \\d+\\.\\d s \\|$`, "m"));
    }
    expect(md).not.toContain("waited out the last flip");
  });

  test("a run that waited out the last flip lists the wait among its steps", async () => {
    const w = world();
    await holdPreviousBuild(w, "b");
    await w.flippedAgo(FLIP_SETTLE_MS - 50);
    const record = runRecord("rollback", false);
    const file = summaryFile();

    await summarized(w.ops, record, summaryWriter(file, []), () =>
      rollback(w.ops, { record }),
    );

    const md = await readFile(file, "utf8");
    expect(md).toMatch(/^\| waited out the last flip \| \d+\.\d s \|$/m);
  });
});

// the one part that runs wrangler's own D1: what `localD1` and the SQL files do under wrangler and its SQLite
describe("refresh and rollback on wrangler's local D1", {
  timeout: 300_000,
}, () => {
  let persistTo: string;
  let built: Awaited<ReturnType<typeof refresh>>;

  beforeAll(async () => {
    persistTo = join(work, "wrangler-d1");
    await migrateAppDb(persistTo);
    built = await refresh(localD1(persistTo), {
      sources: sources(),
      floors: FIXTURE_COUNTS,
      loadDir: join(work, "load-wrangler"),
    });
  }, 300_000);

  /** A copy of the built state under `persistTo`, for a test of its own. */
  async function copyOfBuilt(name: string): Promise<D1Ops> {
    const copy = join(work, name);
    await cp(persistTo, copy, { recursive: true });
    return localD1(copy);
  }

  test("a refresh builds the inactive slot, points the Worker at it, and leaves the other empty", async () => {
    const ops = localD1(persistTo);

    expect(built).toMatchObject({
      slot: "b",
      previous: "a",
      counts: FIXTURE_COUNTS,
    });
    expect(
      await ops.query("APP_DB", "SELECT active, build_id FROM data_generation"),
    ).toStrictEqual([{ active: "b", build_id: built.buildId }]);
    expect(await ops.query("DATA_DB_B", READ_DATA_META_SQL)).toStrictEqual([
      { slot: "b", build_id: built.buildId, state: "complete" },
    ]);
    expect(await ops.query("DATA_DB_B", RED_CROSS)).toMatchObject([
      { name: "AMERICAN NATIONAL RED CROSS" },
    ]);
    expect(
      await ops.query(
        "DATA_DB_B",
        "SELECT rowid FROM orgs_fts WHERE orgs_fts MATCH 'red cross'",
      ),
    ).toStrictEqual([{ rowid: 530196605 }]);
    expect(
      await ops.query(
        "DATA_DB_A",
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ),
    ).toStrictEqual([]);
  });

  test("rollback serves the other slot's complete build again", async () => {
    const ops = await copyOfBuilt("wrangler-d1-rollback");
    const reset = join(work, "reset-a-wrangler.sql");
    await writeFile(reset, resetGenerationSql("a", "old"));
    await ops.applyFile("DATA_DB_A", reset);
    await ops.query(
      "DATA_DB_A",
      "UPDATE data_meta SET state = 'complete', built_at = '2000-01-01T00:00:00Z' WHERE id = 1",
    );
    await ops.query(
      "APP_DB",
      "UPDATE data_generation SET flipped_at = '2000-01-02T00:00:00Z' WHERE id = 1",
    );

    expect(await rollback(ops)).toStrictEqual({
      from: "b",
      to: "a",
      buildId: "old",
    });
    expect(
      await ops.query("APP_DB", "SELECT active, build_id FROM data_generation"),
    ).toStrictEqual([{ active: "a", build_id: "old" }]);
  });
});
