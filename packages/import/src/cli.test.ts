import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  claimSlotSql,
  releaseClaimSql,
  resetGenerationSql,
} from "@nonprofits/db";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { migrateAppDb } from "./test-support.ts";
import { type D1Ops, localD1 } from "./wrangler.ts";

const CLI = fileURLToPath(new URL("cli.ts", import.meta.url));

let work: string;
let persistTo: string;
let ops: D1Ops;

interface Exit {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the CLI on the local state under `persistTo`; sends SIGINT once a
 * stdout line starts with `interruptOn`, and SIGTERM `termAfterMs` after that.
 */
function irs(
  args: string[],
  interruptOn?: string,
  termAfterMs?: number,
): Promise<Exit> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [CLI, ...args, "--persist-to", persistTo],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (
        interruptOn !== undefined &&
        chunk.split("\n").some((line) => line.startsWith(interruptOn))
      ) {
        child.kill("SIGINT");
        if (termAfterMs !== undefined) {
          setTimeout(() => child.kill("SIGTERM"), termAfterMs);
        }
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

const pointer = () =>
  ops.query<{ active: string; build_id: string; flipped_at: string }>(
    "APP_DB",
    "SELECT active, build_id, flipped_at FROM data_generation WHERE id = 1",
  );

/** The command lines of the processes running now. */
function processes(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-eo", "args="], (error, stdout) =>
      error === null ? resolve(stdout.split("\n")) : reject(error),
    );
  });
}

/** Wrangler commands of this file's state that are running the rollback's flip. */
async function runningFlips(): Promise<string[]> {
  return (await processes()).filter(
    (args) => args.includes(persistTo) && args.includes("SET active ="),
  );
}

const claimHolder = async () =>
  (
    await ops.query<{ claim_build_id: string | null }>(
      "APP_DB",
      "SELECT claim_build_id FROM data_generation WHERE id = 1",
    )
  )[0]?.claim_build_id;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "irs-cli-"));
  persistTo = join(work, "d1");
  await migrateAppDb(persistTo);
  ops = localD1(persistTo);
  // slot b: a complete build, served before the pointer last moved to a
  const reset = join(work, "reset-b.sql");
  await writeFile(reset, resetGenerationSql("b", "old"));
  await ops.applyFile("DATA_DB_B", reset);
  await ops.query(
    "DATA_DB_B",
    "UPDATE data_meta SET state = 'complete', built_at = '2000-01-01T00:00:00Z' WHERE id = 1",
  );
  await ops.query(
    "APP_DB",
    "UPDATE data_generation SET flipped_at = '2000-01-02T00:00:00Z' WHERE id = 1",
  );
}, 60_000);

afterAll(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

describe("irs", { timeout: 90_000 }, () => {
  test("a flag the command doesn't take is a usage error", async () => {
    const exit = await irs(["refresh", "--build", "x"]);

    expect(exit.code).toBe(2);
    expect(exit.stderr).toContain("refresh takes no --build");
  });

  test("a single-source load into a sealed slot fails, naming the reset that readies it", async () => {
    const exit = await irs(["bmf", "--slot", "b"]);

    expect(exit.code).toBe(1);
    expect(exit.stderr).toContain(
      `slot b (DATA_DB_B) is sealed (build old): pnpm --filter @nonprofits/worker db:reset:local b --persist-to ${persistTo} resets it for a load`,
    );
  });

  test("SIGINT after the claim stops the run, releases the claim, leaves the pointer and the flip dead, and exits 130", async () => {
    const before = await pointer();

    const exit = await irs(["rollback"], "claimed slot");

    expect(exit.code).toBe(130);
    expect(exit.stderr).toContain("SIGINT: stopping");
    // the pointer read comes last, and a loaded machine can push it past the stop's 7 s
    expect(exit.stderr).toMatch(
      /serving slot [ab] \(build|stop cut off after 7 s/,
    );
    expect(await claimHolder()).toBeNull();
    // the flip was under way when the signal came: killed, it never landed
    expect(await runningFlips()).toStrictEqual([]);
    expect(await pointer()).toStrictEqual(before);
  });

  test("a SIGTERM a second into the SIGINT's cleanup waits for it: the claim is released, exit 130", async () => {
    const before = await pointer();

    const exit = await irs(["rollback"], "claimed slot", 1_000);

    expect(exit.code).toBe(130);
    expect(exit.stderr).toContain("released build old's claim");
    expect(exit.stderr).not.toContain("could not release");
    expect(await claimHolder()).toBeNull();
    expect(await runningFlips()).toStrictEqual([]);
    expect(await pointer()).toStrictEqual(before);
  });

  test("a stopped rollback's --summary says what stopped it, what its cleanup did and the failure the kill caused", async () => {
    const summary = join(work, "stopped.md");
    const [before] = await pointer();

    const exit = await irs(
      ["rollback", "--summary", summary],
      "claimed slot",
      1_000,
    );

    expect(exit.code).toBe(130);
    const md = await readFile(summary, "utf8");
    expect(md).toContain("## irs rollback (local D1): stopped by SIGINT\n");
    expect(md).toContain("**Stopped:** SIGINT\n");
    // a loaded machine can push the cleanup past the stop's 7 s
    expect(md).toMatch(
      /^- (released build old's claim|stop cut off after 7 s)$/m,
    );
    expect(md).toContain(
      `| served before | ${before?.active} | ${before?.build_id} |`,
    );
    // the killed flip fails the run, so a stop's summary carries that failure too, after its own line
    const stopped = md.indexOf("**Stopped:**");
    const failed = md.indexOf(
      "**Failed:** flip failed: wrangler d1 execute stopped",
    );
    expect(stopped).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(stopped);
  });

  test("a refresh refused by another build's claim exits 1 and its --summary carries the refusal", async () => {
    const [{ active } = { active: "a" }] = await ops.query<{ active: string }>(
      "APP_DB",
      "SELECT active FROM data_generation WHERE id = 1",
    );
    const inactive = active === "a" ? "b" : "a";
    await ops.query("APP_DB", claimSlotSql(inactive, "other"));
    const summary = join(work, "refused.md");

    const exit = await irs(["refresh", "--summary", summary]);
    await ops.query("APP_DB", releaseClaimSql("other"));

    expect(exit.code).toBe(1);
    const md = await readFile(summary, "utf8");
    expect(md).toContain("## irs refresh (local D1): failed\n");
    expect(md).toContain(
      `**Failed:** refresh refused: slot ${inactive} is served, another build holds its claim`,
    );
    expect(md).toContain(`| served after | ${active} | empty |`);
  });

  test("--force-verify-failure is refresh's alone", async () => {
    const exit = await irs(["rollback", "--force-verify-failure"]);

    expect(exit.code).toBe(2);
    expect(exit.stderr).toContain("rollback takes no --force-verify-failure");
  });

  test("release clears a stuck claim and says whose", async () => {
    const [{ active } = { active: "a" }] = await ops.query<{ active: string }>(
      "APP_DB",
      "SELECT active FROM data_generation WHERE id = 1",
    );
    const inactive = active === "a" ? "b" : "a";
    await ops.query("APP_DB", claimSlotSql(inactive, "stuck"));

    const exit = await irs(["release"]);

    expect(exit.code).toBe(0);
    expect(exit.stdout).toContain(
      `cleared build stuck's claim on slot ${inactive}`,
    );
    expect(await claimHolder()).toBeNull();
  });
});
