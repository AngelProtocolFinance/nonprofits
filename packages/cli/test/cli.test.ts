import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createWorkerHarness,
  resetDataSlot,
  TEST_SECRETS,
  testEnv,
} from "../../worker/test/harness.ts";
import { run } from "../src/index.ts";

const server = createWorkerHarness();
let baseUrl: string;

beforeAll(async () => {
  baseUrl = (await server.listen()).url.href;
  await server.getWorker().applyD1Migrations("APP_DB");
  // the served data DB, empty: an authorized lookup is not_found
  await resetDataSlot(server, "a");
});

afterAll(async () => {
  await server.close();
});

async function cli(
  args: string[],
  adminToken = TEST_SECRETS.ADMIN_TOKEN,
  url = baseUrl,
) {
  let stdout = "";
  let stderr = "";
  const code = await run(args, {
    env: { NONPROFITS_URL: url, ADMIN_TOKEN: adminToken },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

/** A port that was just free and is now closed, so a connection to it is refused. */
async function closedPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const address = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return address.port;
}

function idOf(createStderr: string): string {
  return /^Created key (\S+)/.exec(createStderr)?.[1] ?? "";
}

function lookupWith(key: string) {
  return server.fetch("/v1/orgs/530196605", {
    headers: { authorization: `Bearer ${key}` },
  });
}

describe("keys CLI", () => {
  test("create prints the key once, on stdout alone, and the key authorizes", async () => {
    const { code, stdout, stderr } = await cli([
      "create",
      "--email",
      "owner@example.org",
      "--name",
      "ci",
    ]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^npk_[A-Za-z]{64}\n$/);
    const key = stdout.trim();
    expect(stderr).not.toContain(key);
    expect(stderr).toMatch(
      /^Created key \S+ \("ci"\) for owner@example\.org\. It is shown once: store it now\.\n$/,
    );
    // D1 here holds no orgs: not_found means the key got past the guard
    expect(await (await lookupWith(key)).json()).toMatchObject({
      code: "not_found",
    });
  });

  test("revoke <key-id> turns the key off on its next request", async () => {
    const created = await cli(["create", "--email", "owner@example.org"]);
    const key = created.stdout.trim();
    const id = /^Created key (\S+)/.exec(created.stderr)?.[1] ?? "";

    const { code, stderr } = await cli(["revoke", id]);

    expect(code).toBe(0);
    expect(stderr).toBe(`Revoked key ${id}.\n`);
    const response = await lookupWith(key);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "revoked_api_key" });
  });

  test("a refused admin call exits 1 with the server's reason", async () => {
    const { code, stdout, stderr } = await cli(
      ["create", "--email", "owner@example.org"],
      "wrong-admin-token-0123456789abcdef",
    );
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "admin_unauthorized: Admin endpoints need `Authorization: Bearer <ADMIN_TOKEN>`.\n",
    );
  });

  test("an unreachable Worker exits 1 with one line naming NONPROFITS_URL and wrangler dev", async () => {
    const url = `http://127.0.0.1:${await closedPort()}/`;
    const { code, stdout, stderr } = await cli(
      ["revoke", "some-id"],
      TEST_SECRETS.ADMIN_TOKEN,
      url,
    );
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      `Can't reach the Worker at ${url} (NONPROFITS_URL). Start it locally with \`pnpm --filter @nonprofits/worker dev\` (wrangler dev), or point NONPROFITS_URL at the deployed Worker.\n`,
    );
  });

  test("set-limit whitelists a key with its own limits, and --default puts it back", async () => {
    const created = await cli(["create", "--email", "owner@example.org"]);
    const key = created.stdout.trim();
    const id = idOf(created.stderr);

    const raised = await cli([
      "set-limit",
      id,
      "--daily",
      "1",
      "--per-minute",
      "60",
    ]);
    expect(raised).toStrictEqual({
      code: 0,
      stdout: "",
      stderr: `Key ${id} is whitelisted: 1/day, 60/min.\n`,
    });
    expect((await lookupWith(key)).status).toBe(404);
    expect((await lookupWith(key)).status).toBe(429);

    const reset = await cli(["set-limit", id, "--default"]);
    expect(reset).toStrictEqual({
      code: 0,
      stdout: "",
      stderr: `Key ${id} is on the default limits: 50/day, 10/min.\n`,
    });
    expect((await lookupWith(key)).status).toBe(404);
  });

  test.each([
    [["set-limit", "some-id"]],
    [["set-limit", "some-id", "--daily", "500"]],
    [["set-limit", "some-id", "--daily", "0", "--per-minute", "60"]],
    [["set-limit", "some-id", "--daily", "5e2", "--per-minute", "60"]],
    [
      [
        "set-limit",
        "some-id",
        "--default",
        "--daily",
        "500",
        "--per-minute",
        "60",
      ],
    ],
  ])(
    "set-limit refuses %j with usage, before calling the Worker",
    async (args) => {
      const { code, stdout, stderr } = await cli(args);
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toMatch(
        /^set-limit takes <key-id> and either --daily <n> --per-minute <n> \(positive integers\) or --default\n\nUsage:/,
      );
    },
  );

  test("set-limit on an id that was never issued exits 1 with key_not_found", async () => {
    const { code, stderr } = await cli([
      "set-limit",
      "no-such-key",
      "--daily",
      "500",
      "--per-minute",
      "60",
    ]);
    expect(code).toBe(1);
    expect(stderr).toBe("key_not_found: No key with id no-such-key.\n");
  });

  test("list shows each key's owner, status, tier, limits and today's usage, and never a key or its hash", async () => {
    const used = await cli([
      "create",
      "--email",
      "list@example.org",
      "--name",
      "listed",
    ]);
    const usedId = idOf(used.stderr);
    await cli(["set-limit", usedId, "--daily", "500", "--per-minute", "60"]);
    await lookupWith(used.stdout.trim());
    await lookupWith(used.stdout.trim());
    const revoked = await cli(["create", "--email", "list@example.org"]);
    const revokedId = idOf(revoked.stderr);
    await cli(["revoke", revokedId]);

    const { code, stdout, stderr } = await cli(["list"]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const rows = stdout
      .trimEnd()
      .split("\n")
      .map((line) => line.split(/ {2,}/));
    expect(rows[0]).toStrictEqual([
      "ID",
      "NAME",
      "OWNER",
      "STATUS",
      "TIER",
      "DAILY",
      "PER_MIN",
      "TODAY",
    ]);
    expect(rows.find(([id]) => id === usedId)).toStrictEqual([
      usedId,
      "listed",
      "list@example.org",
      "active",
      "whitelisted",
      "500",
      "60",
      "2",
    ]);
    expect(rows.find(([id]) => id === revokedId)).toStrictEqual([
      revokedId,
      "-",
      "list@example.org",
      "revoked",
      "default",
      "50",
      "10",
      "0",
    ]);
    const { APP_DB } = await testEnv(server);
    const stored = await APP_DB.prepare("SELECT key FROM apikey").all<{
      key: string;
    }>();
    for (const secret of [
      used.stdout.trim(),
      revoked.stdout.trim(),
      ...stored.results.map((r) => r.key),
    ]) {
      expect(stdout).not.toContain(secret);
    }
  });
});
