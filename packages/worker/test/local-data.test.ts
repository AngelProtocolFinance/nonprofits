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
let persistTo: string;

/** `wrangler d1 execute <binding> --local --command`, against `persistTo`. */
async function query<T>(binding: string, sql: string): Promise<T[]> {
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

beforeAll(async () => {
  persistTo = await mkdtemp(join(tmpdir(), "local-data-"));
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
}, 60_000);

afterAll(async () => {
  await rm(persistTo, { recursive: true, force: true });
});

test("a local reset claims its slot for 10 min, after which a refresh can claim it", async () => {
  await run(
    process.execPath,
    ["scripts/local-data.ts", "reset", "b", "--persist-to", persistTo],
    { cwd: WORKER, env: ENV },
  );

  const [claim] = await query<{ claimed_at: string; claim_expires_at: string }>(
    "APP_DB",
    "SELECT claimed_at, claim_expires_at FROM data_generation",
  );
  expect(claim).toBeDefined();
  const { claimed_at, claim_expires_at } = claim as NonNullable<typeof claim>;
  expect(Date.parse(claim_expires_at) - Date.parse(claimed_at)).toBe(600_000);
  expect(
    await query("APP_DB", claimSlotSql("b", "refresh", claim_expires_at)),
  ).toHaveLength(1);
}, 60_000);
