import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createWorkerHarness,
  serveDataSlot,
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
  await serveDataSlot(server, "a", "empty-a");
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

/** A stand-in Worker on loopback that records each request's path and answers with `respond`. */
async function recordingServer(
  respond: (path: string) => {
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
  },
) {
  const paths: string[] = [];
  const listener = createHttpServer((request, response) => {
    const path = request.url ?? "";
    paths.push(path);
    const { status, headers = {}, body } = respond(path);
    response.writeHead(status, {
      "content-type": "application/json",
      ...headers,
    });
    response.end(body === undefined ? undefined : JSON.stringify(body));
  });
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const address = listener.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    paths,
    close: () => new Promise((resolve) => listener.close(resolve)),
  };
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

  test("an unreachable local Worker exits 1 with one line naming NONPROFITS_URL, the network error and wrangler dev", async () => {
    const url = `http://127.0.0.1:${await closedPort()}/`;
    const { code, stdout, stderr } = await cli(
      ["revoke", "some-id"],
      TEST_SECRETS.ADMIN_TOKEN,
      url,
    );
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      `Can't reach the Worker at ${url} (NONPROFITS_URL): connect ECONNREFUSED ${url.slice("http://".length, -1)}. Start it locally with \`pnpm --filter @nonprofits/worker dev\` (wrangler dev), or point NONPROFITS_URL at the deployed Worker.\n`,
    );
  });

  test("an unreachable deployed Worker exits 1 with the network error and no wrangler dev hint", async () => {
    const url = "https://nonprofits.invalid/";
    const { code, stdout, stderr } = await cli(
      ["list"],
      TEST_SECRETS.ADMIN_TOKEN,
      url,
    );
    expect(code).toBe(1);
    expect(stdout).toBe("");
    // .invalid never resolves (RFC 6761): the cause is the resolver's, or an egress proxy's refusal
    expect(stderr).toMatch(
      /^Can't reach the Worker at https:\/\/nonprofits\.invalid\/ \(NONPROFITS_URL\): (getaddrinfo \w+ nonprofits\.invalid|Proxy response \(\d+\)[^\n]*)\.\n$/,
    );
  });

  test.each([
    ["not a url", "NONPROFITS_URL is not a URL: not a url"],
    [
      "ftp://nonprofits.example.org/",
      "NONPROFITS_URL must be an https:// URL: ftp://nonprofits.example.org/",
    ],
  ])(
    "refuses NONPROFITS_URL %j with exit 2 before any request",
    async (url, message) => {
      const { code, stdout, stderr } = await cli(
        ["list"],
        TEST_SECRETS.ADMIN_TOKEN,
        url,
      );
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toBe(`${message}\n`);
    },
  );

  test("never follows a redirect, which would carry ADMIN_TOKEN elsewhere: exits 1 naming it", async () => {
    const worker = await recordingServer((path) =>
      path === "/admin/keys"
        ? { status: 302, headers: { location: "/elsewhere/admin/keys" } }
        : { status: 200, body: { day: "2026-10-03", keys: [] } },
    );
    try {
      const { code, stdout, stderr } = await cli(
        ["list"],
        TEST_SECRETS.ADMIN_TOKEN,
        `${worker.origin}/`,
      );
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toMatch(/\(NONPROFITS_URL\): unexpected redirect\. /);
      expect(worker.paths).toStrictEqual(["/admin/keys"]);
    } finally {
      await worker.close();
    }
  });

  test.each(["/nonprofits", "/nonprofits/"])(
    "keeps a path prefix in NONPROFITS_URL (%s): admin calls go under it",
    async (prefix) => {
      const worker = await recordingServer(() => ({
        status: 200,
        body: { day: "2026-10-03", keys: [] },
      }));
      try {
        const { code } = await cli(
          ["list"],
          TEST_SECRETS.ADMIN_TOKEN,
          `${worker.origin}${prefix}`,
        );
        expect(code).toBe(0);
        expect(worker.paths).toStrictEqual(["/nonprofits/admin/keys"]);
      } finally {
        await worker.close();
      }
    },
  );

  test("sends http:// to localhost: loopback is the one place plain http is allowed", async () => {
    const worker = await recordingServer(() => ({
      status: 200,
      body: { day: "2026-10-03", keys: [] },
    }));
    try {
      const { code } = await cli(
        ["list"],
        TEST_SECRETS.ADMIN_TOKEN,
        worker.origin.replace("127.0.0.1", "localhost"),
      );
      expect(code).toBe(0);
      expect(worker.paths).toStrictEqual(["/admin/keys"]);
    } finally {
      await worker.close();
    }
  });

  test.each([
    "http://nonprofits.example.org/",
    "http://10.0.0.5:8787/",
    "http://127.0.0.1.nip.io/",
  ])(
    "refuses to send ADMIN_TOKEN over plain http to %s, which isn't loopback: exit 2 before any request",
    async (url) => {
      const { code, stdout, stderr } = await cli(
        ["list"],
        TEST_SECRETS.ADMIN_TOKEN,
        url,
      );
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toBe(
        `NONPROFITS_URL must be https:// (http:// only for localhost, 127.0.0.1 or [::1]): ADMIN_TOKEN would cross the network in the clear to ${url}\n`,
      );
    },
  );

  test("without ADMIN_TOKEN it exits 2 saying what to set, before any request", async () => {
    const worker = await recordingServer(() => ({ status: 200, body: {} }));
    try {
      let stderr = "";
      const code = await run(["list"], {
        env: { NONPROFITS_URL: worker.origin },
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
      });

      expect(code).toBe(2);
      expect(stderr).toBe(
        "Set ADMIN_TOKEN to the Worker's ADMIN_TOKEN secret.\n",
      );
      expect(worker.paths).toStrictEqual([]);
    } finally {
      await worker.close();
    }
  });

  test.each([
    { args: [], message: "no command" },
    { args: ["rotate"], message: "unknown command rotate" },
    { args: ["create"], message: "--email is required" },
    { args: ["create", "--name", "ci"], message: "--email is required" },
    { args: ["revoke"], message: "revoke takes exactly one <key-id>" },
    {
      args: ["revoke", "one-id", "another-id"],
      message: "revoke takes exactly one <key-id>",
    },
  ])(
    "$args exits 2 with $message and the usage, before any request",
    async ({ args, message }) => {
      const worker = await recordingServer(() => ({ status: 200, body: {} }));
      try {
        const { code, stdout, stderr } = await cli(
          args,
          TEST_SECRETS.ADMIN_TOKEN,
          worker.origin,
        );

        expect(code).toBe(2);
        expect(stdout).toBe("");
        expect(stderr).toMatch(
          new RegExp(`^${message}\\n\\nUsage:\\n  keys create --email`),
        );
        expect(worker.paths).toStrictEqual([]);
      } finally {
        await worker.close();
      }
    },
  );

  test.each([
    { args: ["list", "extra"] },
    { args: ["list", "--all"] },
    { args: ["create", "--email", "owner@example.org", "--bogus"] },
  ])("$args exits 2 with the usage, before any request", async ({ args }) => {
    const worker = await recordingServer(() => ({ status: 200, body: {} }));
    try {
      const { code, stderr } = await cli(
        args,
        TEST_SECRETS.ADMIN_TOKEN,
        worker.origin,
      );

      expect(code).toBe(2);
      expect(stderr).toContain("\n\nUsage:\n  keys create --email");
      expect(worker.paths).toStrictEqual([]);
    } finally {
      await worker.close();
    }
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

  test("set-limit past the per-client cap of 600 a minute exits 1 with the Worker's reason", async () => {
    const created = await cli(["create", "--email", "owner@example.org"]);

    const { code, stdout, stderr } = await cli([
      "set-limit",
      idOf(created.stderr),
      "--daily",
      "100000",
      "--per-minute",
      "601",
    ]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "invalid_request: `perMinute` can be at most 600: every client is capped at 600 requests a minute carrying an API key, before the key is read, so a higher limit is never reached.\n",
    );
  });

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
