import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { quickRetry } from "./test-support.ts";
import {
  remoteD1,
  stopWrangler,
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

/** A runner answering each call from `outputs` in turn, recording the args it was given. */
function scripted(...outputs: (string | Error)[]): WranglerRun & {
  calls: string[][];
} {
  const calls: string[][] = [];
  const run = async (args: readonly string[]) => {
    calls.push([...args]);
    const next = outputs.shift();
    if (next === undefined) throw new Error("no output scripted");
    if (next instanceof Error) throw next;
    return next;
  };
  return Object.assign(run, { calls });
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

describe("wrangler", { timeout: 60_000 }, () => {
  test("runs a command to its output", async () => {
    expect(await wrangler(select(), 60_000)).toContain('"1": 1');
  });

  test("kills a command that outlives its timeout", async () => {
    await expect(wrangler(select(), 200)).rejects.toThrow(
      "wrangler d1 execute timed out after 200 ms",
    );
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

  // last: a stop leaves the module refusing every call but its cleanup's
  test("stopWrangler kills the running command, refuses the run's next one, then runs its cleanup alone", async () => {
    const running = wrangler(select(), 60_000);
    const stopped = expect(running).rejects.toThrow(
      "wrangler d1 execute stopped",
    );

    let killed: readonly (readonly string[])[] = [];
    const cleaned = await stopWrangler((commands) => {
      killed = commands;
      return wrangler(select(), 60_000);
    });

    await stopped;
    expect(killed).toStrictEqual([select()]);
    expect(cleaned).toContain('"1": 1');
    await expect(wrangler(select(), 60_000)).rejects.toThrow(
      "wrangler d1 execute stopped",
    );
  });
});
