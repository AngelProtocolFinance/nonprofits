import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createWorkerHarness,
  TEST_SECRETS,
} from "../../worker/test/harness.ts";
import { run } from "../src/index.ts";

const server = createWorkerHarness();
let baseUrl: string;

beforeAll(async () => {
  baseUrl = (await server.listen()).url.href;
  await server.getWorker().applyD1Migrations("DB");
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
});
