import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fenceSql, resetGenerationSql } from "@nonprofits/db";
import { afterAll, beforeAll, expect, test } from "vitest";

const run = promisify(execFile);
const WORKER = fileURLToPath(new URL("..", import.meta.url));
const ENV = {
  ...process.env,
  PATH: `${join(WORKER, "node_modules", ".bin")}${delimiter}${process.env.PATH}`,
  WRANGLER_SEND_METRICS: "false",
};
let dir: string;

/** `wrangler d1 execute DATA_DB_B --local --file`, as the import runs a load file locally. */
async function executeFile(name: string, sql: string): Promise<void> {
  const file = join(dir, `${name}.sql`);
  await writeFile(file, sql);
  await run(
    "wrangler",
    [
      "d1",
      "execute",
      "DATA_DB_B",
      "--local",
      "--persist-to",
      dir,
      "--file",
      file,
    ],
    { cwd: WORKER, env: ENV },
  );
}

async function orgCount(): Promise<number> {
  const { stdout } = await run(
    "wrangler",
    [
      "d1",
      "execute",
      "DATA_DB_B",
      "--local",
      "--persist-to",
      dir,
      "--json",
      "--command",
      "SELECT count(*) AS n FROM orgs",
    ],
    { cwd: WORKER, env: ENV },
  );
  return (JSON.parse(stdout) as { results: { n: number }[] }[])[0]?.results[0]
    ?.n as number;
}

const LOAD = `INSERT INTO import_runs VALUES (1, 'bmf', 'https://example.invalid/bmf', '2026-09-08', '2026-09-10', 1);
INSERT INTO orgs (ein, name, name_run_id, ruling_date, revocation_date, reinstatement_date) VALUES ('530196605', 'AMERICAN NATIONAL RED CROSS', 1, '1946-06', '2010-05-15', '2026-08-15');
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fence-"));
  await executeFile("reset", resetGenerationSql("b", "build-2"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a local load file fenced for a build its slot no longer holds fails whole, writing nothing", async () => {
  await expect(
    executeFile("stale", `${fenceSql("build-1")}${LOAD}`),
  ).rejects.toThrow("load refused: this slot is not building the load's build");

  expect(await orgCount()).toBe(0);
});

test("a local load file fenced for the build filling its slot loads", async () => {
  await executeFile("own", `${fenceSql("build-2")}${LOAD}`);

  expect(await orgCount()).toBe(1);
});
