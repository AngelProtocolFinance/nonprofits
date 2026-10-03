import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestHarness } from "wrangler";
import { lookup } from "../../src/handlers.ts";
import { mcp } from "../../src/mcp.ts";
import { clearOfUtcMidnight } from "../clock-windows.ts";
import { failingD1 } from "./failing-d1.ts";
import { noBurstLimit } from "./limiters.ts";

// typed against the Worker's globals, not node's: this file imports Worker source
const server = createTestHarness({
  workers: [
    {
      configPath: new URL("../../wrangler.jsonc", import.meta.url),
      secrets: {
        BETTER_AUTH_SECRET: "test-only-better-auth-secret-0123456789abcdef",
        ADMIN_TOKEN: "test-only-admin-token-0123456789abcdef",
        IP_HASH_SECRET: "test-only-ip-hash-secret-0123456789abcdef",
      },
    },
  ],
});
let env: Env;

beforeAll(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
  env = (await server.getWorker().getEnv()) as Env;
});

afterAll(async () => {
  await server.close();
});

/** A keyless MCP client from `ip`, served by `/mcp` under `workerEnv`. */
async function connect(workerEnv: Env, ip: string): Promise<Client> {
  const client = new Client({ name: "mcp-direct-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      requestInit: { headers: { "cf-connecting-ip": ip } },
      fetch: (url, init) => mcp(new Request(url, init), workerEnv),
    }),
  );
  return client;
}

/** A keyless REST lookup from `ip`; this D1 holds no orgs, so an admitted one is not_found. */
async function restLookup(workerEnv: Env, ip: string) {
  const result = await lookup("530196605", {
    env: workerEnv,
    credential: null,
    clientIp: ip,
    cfWorker: null,
    now: new Date(),
  });
  return result.ok ? "ok" : result.error.code;
}

test("without a key, tool calls and REST requests from one IP share its 5 a day; handshakes and tool listings count none", async () => {
  const unlimitedBursts = { ...env, KEYLESS_BURST_LIMITER: noBurstLimit };
  const ip = "203.0.113.120";
  await clearOfUtcMidnight();
  expect(await restLookup(unlimitedBursts, ip)).toBe("not_found");
  expect(await restLookup(unlimitedBursts, ip)).toBe("not_found");
  const lookupCall = {
    name: "lookup_nonprofit",
    arguments: { ein: "530196605" },
  };
  const searchCall = {
    name: "search_nonprofits",
    arguments: { query: "red cross" },
  };
  // served: no orgs here, so a lookup is not_found and a search finds none
  const served = [
    [lookupCall, { code: "not_found" }],
    [searchCall, { results: [] }],
    [lookupCall, { code: "not_found" }],
  ] as const;
  for (const [call, answer] of served) {
    const client = await connect(unlimitedBursts, ip);
    await client.listTools();
    await client.listTools();
    expect((await client.callTool(call)).structuredContent).toMatchObject(
      answer,
    );
    await client.close();
  }
  const client = await connect(unlimitedBursts, ip);

  const result = await client.callTool(searchCall);

  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    status: 429,
    code: "daily_quota_exceeded",
  });
  const { retryAfterSeconds } = result.structuredContent as {
    retryAfterSeconds: number;
  };
  expect(retryAfterSeconds).toBeGreaterThan(0);
  expect(retryAfterSeconds).toBeLessThanOrEqual(24 * 60 * 60);
  await client.close();
}, 30_000);

test("a D1 outage behind a tool call is a tool error carrying the REST 503 problem", async () => {
  const orgsDown = { ...env, DB: failingD1(env.DB, /FROM orgs/) };
  const client = await connect(orgsDown, "203.0.113.121");

  const result = await client.callTool({
    name: "lookup_nonprofit",
    arguments: { ein: "530196605" },
  });

  const detail =
    "The org data store failed to answer; nothing is wrong with your request. Retry shortly.";
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toStrictEqual({
    type: "about:blank",
    title: "Service Unavailable",
    status: 503,
    code: "data_unavailable",
    detail,
  });
  expect(result.content).toStrictEqual([
    { type: "text", text: `data_unavailable: ${detail}` },
  ]);
  await client.close();
});
