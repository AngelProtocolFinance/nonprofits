import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Client } from "@libsql/client";
import { readDataCounts, readDataMeta } from "@nonprofits/db";
import { dataDbClient } from "@nonprofits/db/node";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type BuildReport, buildDataFile } from "./build.ts";
import {
  FIXTURE_COUNTS,
  fixtureServer,
  fixtureSources,
} from "./test-support.ts";
import type { Counts } from "./verify.ts";

let server: Server;
let base: string;
let work: string;

beforeAll(async () => {
  ({ server, base } = await fixtureServer());
  work = await mkdtemp(join(tmpdir(), "build-file-"));
}, 60_000);

afterAll(async () => {
  server?.close();
  if (work) await rm(work, { recursive: true, force: true });
});

function build(
  name: string,
  options: { served?: Counts; forceVerifyFailure?: boolean } = {},
): Promise<BuildReport> {
  return buildDataFile({
    sources: fixtureSources(base, join(work, name, "efile")),
    floors: FIXTURE_COUNTS,
    out: join(work, name, "data.db"),
    loadDir: join(work, name, "load"),
    ...options,
  });
}

/** A client on the finished file at `out`, closed once `use` settles. */
async function reading<T>(
  out: string,
  use: (data: Client) => Promise<T>,
): Promise<T> {
  const data = dataDbClient(pathToFileURL(out).href, {});
  try {
    return await use(data);
  } finally {
    data.close();
  }
}

async function pragma(data: Client, name: string): Promise<unknown> {
  const rs = await data.execute(`PRAGMA ${name}`);
  return rs.rows[0]?.[name];
}

describe("a build of the fixtures", { timeout: 60_000 }, () => {
  let report: BuildReport;

  beforeAll(async () => {
    // within 10% of every count
    report = await build("ok", { served: { ...FIXTURE_COUNTS, orgs: 250 } });
  }, 60_000);

  test("leaves a file in the format Turso's upload takes, its WAL empty", async () => {
    expect(report.out).toBe(join(work, "ok", "data.db"));
    expect(existsSync(`${report.out}-wal`)).toBe(false);
    const format = await reading(report.out, async (data) => ({
      page_size: await pragma(data, "page_size"),
      journal_mode: await pragma(data, "journal_mode"),
      auto_vacuum: await pragma(data, "auto_vacuum"),
    }));
    expect(format).toStrictEqual({
      page_size: 4096,
      journal_mode: "wal",
      auto_vacuum: 0,
    });
  });

  test("answers the Red Cross with its mission, and its search index finds it by name", async () => {
    const found = await reading(report.out, async (data) => ({
      redCross: (
        await data.execute(
          "SELECT o.name, f.mission FROM orgs o JOIN filings f ON f.ein = o.ein WHERE o.ein = '530196605'",
        )
      ).rows.map((row) => ({ ...row })),
      search: (
        await data.execute(
          "SELECT rowid FROM orgs_fts WHERE orgs_fts MATCH 'american national red cross'",
        )
      ).rows.map((row) => ({ ...row })),
      meta: await readDataMeta(data),
    }));
    expect(found.redCross).toStrictEqual([
      {
        name: "AMERICAN NATIONAL RED CROSS",
        mission: expect.stringMatching(/\S/),
      },
    ]);
    expect(found.search).toStrictEqual([{ rowid: 530196605 }]);
    expect(found.meta?.build_id).toBe(report.buildId);
  });

  test("reports its counts, each checked against the served build's, and every check passed", () => {
    expect(report.counts).toStrictEqual(FIXTURE_COUNTS);
    expect(report.checks.map((check) => check.name)).toContain(
      "orgs vs served",
    );
    expect(report.checks.filter((check) => !check.ok)).toStrictEqual([]);
  });

  test("records the counts verify passed in its data_meta, for the next build to read as served", async () => {
    const recorded = await reading(report.out, readDataCounts);
    expect(recorded).toStrictEqual(FIXTURE_COUNTS);
  });
});

describe("a build that fails verify", { timeout: 60_000 }, () => {
  test("throws naming the failed check, and leaves no file at the output path, even one an earlier build left", async () => {
    const out = join(work, "forced", "data.db");
    await build("forced");
    expect((await stat(out)).size).toBeGreaterThan(0);
    await writeFile(`${out}-wal`, "an earlier build's WAL");
    await writeFile(`${out}-shm`, "an earlier build's WAL index");

    await expect(build("forced", { forceVerifyFailure: true })).rejects.toThrow(
      "forced failure (--force-verify-failure was given)",
    );
    expect(
      [out, `${out}-wal`, `${out}-shm`, `${out}.building`].filter(existsSync),
    ).toStrictEqual([]);
  });

  test("fails a count more than 10% off the served build's", async () => {
    const out = join(work, "served", "data.db");

    await expect(
      build("served", { served: { ...FIXTURE_COUNTS, orgs: 300 } }),
    ).rejects.toThrow("orgs vs served (orgs: 260, served 300)");
    expect(existsSync(out)).toBe(false);
  });
});

describe("a build whose file cannot be set up", { timeout: 60_000 }, () => {
  test("throws and leaves no file behind, at the output path or beside it", async () => {
    const out = join(work, "no-schema", "data.db");
    // SQLite cannot open its rollback journal over a directory
    await mkdir(`${out}.building-journal`, { recursive: true });

    await expect(build("no-schema")).rejects.toThrow("SQLITE_CANTOPEN");
    expect([out, `${out}.building`].filter(existsSync)).toStrictEqual([]);
  });
});
