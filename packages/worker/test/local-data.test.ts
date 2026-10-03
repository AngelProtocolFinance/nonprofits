import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { claimSlotSql } from "@nonprofits/db";
import { afterAll, beforeAll, expect, test } from "vitest";

const run = promisify(execFile);
const WORKER = fileURLToPath(new URL("..", import.meta.url));
// as `pnpm <script>` runs them: the package's own wrangler first on PATH
const ENV = {
  ...process.env,
  PATH: `${join(WORKER, "node_modules", ".bin")}${delimiter}${process.env.PATH}`,
  WRANGLER_SEND_METRICS: "false",
};
/** `wrangler d1 execute <binding> --local --command`, against the state in `persistTo`. */
async function query<T>(
  persistTo: string,
  binding: string,
  sql: string,
): Promise<T[]> {
  const { stdout } = await run(
    "wrangler",
    [
      "d1",
      "execute",
      binding,
      "--local",
      "--persist-to",
      persistTo,
      "--json",
      "--command",
      sql,
    ],
    { cwd: WORKER, env: ENV },
  );
  return (JSON.parse(stdout) as { results: T[] }[]).at(-1)?.results ?? [];
}

/** A temp `--persist-to` directory with the app migrations applied. */
async function migratedState(): Promise<string> {
  const persistTo = await mkdtemp(join(tmpdir(), "local-data-"));
  await run(
    "wrangler",
    [
      "d1",
      "migrations",
      "apply",
      "APP_DB",
      "--local",
      "--persist-to",
      persistTo,
    ],
    { cwd: WORKER, env: ENV },
  );
  return persistTo;
}

/** `scripts/local-data.ts <args>` against `persistTo`, as `pnpm db:<command>:local` runs it. */
async function localData(persistTo: string, ...args: string[]) {
  return run(
    process.execPath,
    ["scripts/local-data.ts", ...args, "--persist-to", persistTo],
    { cwd: WORKER, env: ENV },
  );
}

/** The exit code and stderr of a `local-data.ts` run that fails. */
async function localDataFailure(persistTo: string, ...args: string[]) {
  try {
    await localData(persistTo, ...args);
  } catch (error) {
    const { code, stderr } = error as { code: number; stderr: string };
    return { code, stderr };
  }
  throw new Error(`local-data.ts ${args.join(" ")} succeeded`);
}

// both tests write the script's `.wrangler/<name>.sql` files under WORKER, so they
// stay in one file: separate files would race on them
let leaseState: string;
let chainState: string;

beforeAll(async () => {
  [leaseState, chainState] = await Promise.all([
    migratedState(),
    migratedState(),
  ]);
});

afterAll(async () => {
  await Promise.all(
    [leaseState, chainState].map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

test("a local reset claims its slot for 10 min, refusing a refresh until the lease runs out", async () => {
  await localData(leaseState, "reset", "b");

  const [claim] = await query<{ claimed_at: string; claim_expires_at: string }>(
    leaseState,
    "APP_DB",
    "SELECT claimed_at, claim_expires_at FROM data_generation",
  );
  expect(claim).toBeDefined();
  const { claimed_at, claim_expires_at } = claim as NonNullable<typeof claim>;
  expect(Date.parse(claim_expires_at) - Date.parse(claimed_at)).toBe(600_000);
  expect(
    await query(leaseState, "APP_DB", claimSlotSql("b", "refresh")),
  ).toHaveLength(0);
  // the lease runs out as 10 min passing would leave it
  await query(
    leaseState,
    "APP_DB",
    "UPDATE data_generation SET claim_expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 seconds')",
  );
  expect(
    await query(leaseState, "APP_DB", claimSlotSql("b", "refresh")),
  ).toHaveLength(1);
});

// about 15 wrangler child processes, a second or two each, under a loaded gate
test("reset, seed, search-index and seal build slot b and flip points the Worker at it; flip before the seal exits 1", async () => {
  const state = chainState;
  const pointer = async () =>
    (
      await query<{
        active: string;
        build_id: string;
        claim_slot: string | null;
      }>(
        state,
        "APP_DB",
        "SELECT active, build_id, claim_slot FROM data_generation",
      )
    )[0];
  await localData(state, "reset", "b");

  const early = await localDataFailure(state, "flip", "b");

  expect(early.code).toBe(1);
  // wrangler may print its own warnings (a proxy in the environment) before the script's line
  expect(early.stderr).toMatch(
    /(^|\n)slot b isn't sealed, so the Worker won't serve it: pnpm db:seal:local b\n$/,
  );
  expect(await pointer()).toMatchObject({ active: "a", build_id: "empty" });

  await localData(state, "seed", "b");
  await localData(state, "search-index", "b");
  const sealed = await localData(state, "seal", "b");
  const buildId = /^slot b sealed \(build (local-\S+)\)$/m.exec(
    sealed.stdout,
  )?.[1];
  expect(buildId).toMatch(/^local-\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

  const flipped = await localData(state, "flip", "b");

  expect(flipped.stdout).toBe(`serving slot b (build ${buildId})\n`);
  expect(await pointer()).toStrictEqual({
    active: "b",
    build_id: buildId,
    claim_slot: null,
  });
  // the slot holds the fixture and its name index
  expect(
    await query(
      state,
      "DATA_DB_B",
      `SELECT (SELECT count(*) FROM orgs) AS orgs,
        (SELECT group_concat(rowid) FROM orgs_fts WHERE orgs_fts MATCH 'red cross') AS red_cross`,
    ),
  ).toStrictEqual([{ orgs: 8, red_cross: "530196605" }]);
}, 180_000);
