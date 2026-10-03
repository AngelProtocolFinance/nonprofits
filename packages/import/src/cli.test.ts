import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { claimSlotSql, resetGenerationSql } from "@nonprofits/db";
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

/** Runs the CLI on the local state under `persistTo`; sends SIGINT once a stdout line starts with `interruptOn`. */
function irs(args: string[], interruptOn?: string): Promise<Exit> {
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
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
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

  test("SIGINT after the claim stops the run, releases the claim and exits 130", async () => {
    const exit = await irs(["rollback"], "claimed slot");

    expect(exit.code).toBe(130);
    expect(exit.stderr).toContain("SIGINT: stopping");
    expect(exit.stderr).toMatch(/serving slot [ab] \(build/);
    expect(await claimHolder()).toBeNull();
  });

  test("release clears a stuck claim and says whose", async () => {
    // the interrupted rollback may have flipped; date that flip past the settle
    await ops.query(
      "APP_DB",
      "UPDATE data_generation SET flipped_at = '2000-01-03T00:00:00Z' WHERE id = 1",
    );
    const [{ active } = { active: "a" }] = await ops.query<{ active: string }>(
      "APP_DB",
      "SELECT active FROM data_generation WHERE id = 1",
    );
    const inactive = active === "a" ? "b" : "a";
    await ops.query(
      "APP_DB",
      claimSlotSql(inactive, "stuck", new Date().toISOString()),
    );

    const exit = await irs(["release"]);

    expect(exit.code).toBe(0);
    expect(exit.stdout).toContain(
      `cleared build stuck's claim on slot ${inactive}`,
    );
    expect(await claimHolder()).toBeNull();
  });
});
