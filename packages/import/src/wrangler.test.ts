import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { quickRetry } from "./test-support.ts";
import {
  APPLY_TIMEOUT_MS,
  ImportMayBeRunning,
  localD1,
  QUERY_TIMEOUT_MS,
  remoteD1,
  type WranglerRun,
  wrangler,
} from "./wrangler.ts";

let persistTo: string;

const select = () => [
  "d1",
  "execute",
  "APP_DB",
  "--local",
  "--persist-to",
  persistTo,
  "--command",
  "SELECT 1",
];

beforeAll(async () => {
  persistTo = await mkdtemp(join(tmpdir(), "wrangler-"));
});

afterAll(async () => {
  if (persistTo) await rm(persistTo, { recursive: true, force: true });
});

/** A runner answering each call from `outputs` in turn, recording the args and timeout it was given. */
function scripted(...outputs: (string | Error)[]): WranglerRun & {
  calls: string[][];
  timeouts: number[];
} {
  const calls: string[][] = [];
  const timeouts: number[] = [];
  const run = async (args: readonly string[], timeoutMs: number) => {
    calls.push([...args]);
    timeouts.push(timeoutMs);
    const next = outputs.shift();
    if (next === undefined) throw new Error("no output scripted");
    if (next instanceof Error) throw next;
    return next;
  };
  return Object.assign(run, { calls, timeouts });
}

const ROWS = JSON.stringify([{ results: [{ n: 1 }], success: true }]);

describe("remoteD1", () => {
  test("queries the remote database as JSON, resolving with the last statement's rows", async () => {
    const run = scripted(
      JSON.stringify([
        { results: [{ n: 1 }], success: true },
        { results: [{ n: 2 }, { n: 3 }], success: true },
      ]),
    );

    const rows = await remoteD1({ run }).query("DATA_DB_A", "SELECT n FROM t");

    expect(rows).toStrictEqual([{ n: 2 }, { n: 3 }]);
    expect(run.calls).toStrictEqual([
      [
        "d1",
        "execute",
        "DATA_DB_A",
        "--remote",
        "--yes",
        "--json",
        "--command",
        "SELECT n FROM t",
      ],
    ]);
    expect(run.timeouts).toStrictEqual([QUERY_TIMEOUT_MS]);
  });

  test("applies a file with --file, under the apply timeout", async () => {
    const run = scripted("applied");

    await remoteD1({ run }).applyFile("DATA_DB_B", "/load/efile.load.sql");

    expect(run.calls).toStrictEqual([
      [
        "d1",
        "execute",
        "DATA_DB_B",
        "--remote",
        "--yes",
        "--file",
        "/load/efile.load.sql",
      ],
    ]);
    expect(run.timeouts).toStrictEqual([APPLY_TIMEOUT_MS]);
  });

  test.each([
    ["timed out", "wrangler d1 execute timed out after 7200000 ms"],
    ["was stopped", "wrangler d1 execute stopped"],
    [
      "lost its API polling",
      "wrangler d1 execute failed:\n✘ [ERROR] A request to the Cloudflare API (/accounts/x/d1/database/y/import) failed.",
    ],
    ["lost the network", "wrangler d1 execute failed:\n✘ [ERROR] fetch failed"],
  ])("an apply that %s may still be importing", async (_, failure) => {
    const run = scripted(new Error(failure));

    const error = await remoteD1({ run })
      .applyFile("DATA_DB_A", "x.sql")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ImportMayBeRunning);
    expect(error).toMatchObject({ binding: "DATA_DB_A", message: failure });
  });

  test("an apply whose SQL failed has ended, and fails as wrangler said", async () => {
    const failure =
      "wrangler d1 execute failed: UNIQUE constraint failed: orgs.ein: SQLITE_CONSTRAINT";
    const run = scripted(new Error(failure));

    const error = await remoteD1({ run })
      .applyFile("DATA_DB_A", "x.sql")
      .catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(ImportMayBeRunning);
    expect(error).toMatchObject({ message: failure });
  });

  test("a local apply that lost the network is not a remote import still running", async () => {
    const run = scripted(new Error("wrangler d1 execute failed: fetch failed"));

    const error = await localD1("/state", { run })
      .applyFile("DATA_DB_A", "x.sql")
      .catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(ImportMayBeRunning);
  });

  test("retries a read that failed transiently, saying so", async () => {
    const run = scripted(
      new Error("wrangler d1 execute failed:\n✘ [ERROR] fetch failed"),
      ROWS,
    );
    const retry = quickRetry();

    const rows = await remoteD1({ run, retry }).query("APP_DB", "SELECT 1");

    expect(rows).toStrictEqual([{ n: 1 }]);
    expect(run.calls).toHaveLength(2);
    expect(retry.lines).toStrictEqual([
      "wrangler d1 execute APP_DB failed (wrangler d1 execute failed: ✘ [ERROR] fetch failed); try 2 of 3 in 0.0 s",
    ]);
  });

  test("gives up on a read after the policy's tries, rethrowing the last failure", async () => {
    const run = scripted(
      ...[1, 2, 3].map(
        (n) => new Error(`wrangler d1 execute failed: HTTP 503 (${n})`),
      ),
      ROWS,
    );

    await expect(
      remoteD1({ run, retry: quickRetry() }).query("APP_DB", "SELECT 1"),
    ).rejects.toThrow("wrangler d1 execute failed: HTTP 503 (3)");
    expect(run.calls).toHaveLength(3);
  });

  test.each([
    [
      "a write",
      "UPDATE t SET n = 1 RETURNING n",
      "wrangler d1 execute failed: fetch failed",
    ],
    [
      "a read followed by a write",
      "SELECT 1; DELETE FROM t",
      "wrangler d1 execute failed: fetch failed",
    ],
    [
      "a read the statement failed",
      "SELECT * FROM nope",
      "wrangler d1 execute failed: no such table: nope: SQLITE_ERROR",
    ],
    ["a read the run stopped", "SELECT 1", "wrangler d1 execute stopped"],
  ])("never retries %s", async (_, sql, failure) => {
    const run = scripted(new Error(failure), ROWS);

    await expect(
      remoteD1({ run, retry: quickRetry() }).query("APP_DB", sql),
    ).rejects.toThrow(failure);
    expect(run.calls).toHaveLength(1);
  });

  test.each([
    ["an empty array", "[]"],
    ["a statement without results", JSON.stringify([{ success: true }])],
  ])("throws on output holding %s, naming the command", async (_, out) => {
    const ops = remoteD1({ run: scripted(out) });

    await expect(ops.query("APP_DB", "SELECT 1")).rejects.toThrow(
      `wrangler d1 execute APP_DB returned no result set: ${out}`,
    );
  });
});

describe("localD1", () => {
  test("queries the state under persistTo, as JSON", async () => {
    const run = scripted(ROWS);

    await localD1("/state", { run }).query("APP_DB", "SELECT 1");

    expect(run.calls).toStrictEqual([
      [
        "d1",
        "execute",
        "APP_DB",
        "--local",
        "--persist-to",
        "/state",
        "--json",
        "--command",
        "SELECT 1",
      ],
    ]);
  });

  test("reads wrangler's default state without a persistTo", async () => {
    const run = scripted(ROWS);

    await localD1(undefined, { run }).query("APP_DB", "SELECT 1");

    expect(run.calls[0]).toStrictEqual([
      "d1",
      "execute",
      "APP_DB",
      "--local",
      "--json",
      "--command",
      "SELECT 1",
    ]);
  });
});

describe("wrangler", { timeout: 60_000 }, () => {
  test("runs a command to its output", async () => {
    expect(await wrangler(select(), 60_000)).toContain('"1": 1');
  });

  test("a failure names the JSON error first, then stderr and stdout", async () => {
    // wrangler warns of a proxy on stderr; the failure itself is JSON on stdout
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:9");
    const args = select().map((arg) =>
      arg === "SELECT 1" ? "SELECT * FROM nope" : arg,
    );
    args.splice(args.indexOf("--command"), 0, "--json");
    try {
      const failure = wrangler(args, 60_000);

      await expect(failure).rejects.toThrow(
        /^wrangler d1 execute failed: no such table: nope: SQLITE_ERROR\n[^]*Proxy environment variables detected[^]*"error"/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
