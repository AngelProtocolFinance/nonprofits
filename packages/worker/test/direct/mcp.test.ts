import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createTestHarness } from "wrangler";
import { lookup } from "../../src/handlers.ts";
import worker from "../../src/index.ts";
import { mcp } from "../../src/mcp.ts";
import { clearOfUtcMidnight } from "../clock-windows.ts";
import { emptyServedData } from "./empty-data.ts";
import { failingD1 } from "./failing-d1.ts";
import { noBurstLimit } from "./limiters.ts";
import { noCaches } from "./no-cache.ts";

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
  vi.stubGlobal("caches", noCaches);
  await server.listen();
  await server.getWorker().applyD1Migrations("APP_DB");
  env = (await server.getWorker().getEnv()) as Env;
  await emptyServedData(env);
});

afterAll(async () => {
  vi.unstubAllGlobals();
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

/** A keyless REST lookup from `ip`; the served data DB holds no orgs, so an admitted one is not_found. */
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
  const orgsDown = { ...env, DATA_DB_A: failingD1(env.DATA_DB_A, /FROM orgs/) };
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

test("a message the SDK rejects is logged as one structured error line", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});

  const response = await mcp(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "cf-connecting-ip": "203.0.113.122",
        // names the 2026 revision, but the body lacks its per-request envelope
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    env,
  );
  const lines = errors.mock.calls.map(([line]) => JSON.parse(String(line)));
  errors.mockRestore();

  expect(response.status).toBe(400);
  expect(lines).toContainEqual(
    expect.objectContaining({ event: "mcp_error", cause: expect.any(String) }),
  );
});

/** Every JSON-RPC response in a body sent as JSON or as server-sent events. */
async function rpcResponses(response: Response): Promise<unknown[]> {
  const text = await response.text();
  const payloads = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice("data: ".length)) as unknown)
    : [JSON.parse(text) as unknown];
  return payloads.flat();
}

test("a batch POST of 6 tool calls without a key is metered 6 times: the 6th is past the IP's 5 a day", async () => {
  const unlimitedBursts = { ...env, KEYLESS_BURST_LIMITER: noBurstLimit };
  await clearOfUtcMidnight();
  const batch = [1, 2, 3, 4, 5, 6].map((id) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "lookup_nonprofit", arguments: { ein: "530196605" } },
  }));

  const response = await mcp(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "cf-connecting-ip": "203.0.113.123",
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify(batch),
    }),
    unlimitedBursts,
  );

  type ToolError = { result: { structuredContent: { code: string } } };
  const codes = (await rpcResponses(response))
    .map((message) => (message as ToolError).result.structuredContent.code)
    .sort();
  expect(codes).toStrictEqual([
    "daily_quota_exceeded",
    "not_found",
    "not_found",
    "not_found",
    "not_found",
    "not_found",
  ]);
}, 30_000);

test("a request that throws in a handler answers a 500 problem and logs the cause, not Cloudflare's error page", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const body = new ReadableStream({
    pull: (controller) => controller.error(new Error("client went away")),
  });

  // a request built here carries no incoming `cf` properties, which the handler never reads
  const request = new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "cf-connecting-ip": "203.0.113.124",
    },
    body,
    duplex: "half",
  } as RequestInit) as Parameters<typeof worker.fetch>[0];

  const response = await worker.fetch(request, env);
  const lines = errors.mock.calls.map(([line]) => JSON.parse(String(line)));
  errors.mockRestore();

  expect(response.status).toBe(500);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  expect(await response.json()).toStrictEqual({
    type: "about:blank",
    title: "Internal Server Error",
    status: 500,
    code: "internal_error",
    detail:
      "The request failed on the server. Retry; if it keeps failing, tell the operator.",
  });
  expect(lines).toContainEqual(
    expect.objectContaining({
      event: "internal_error",
      cause: "Error: client went away",
      stack: expect.stringMatching(/^Error: client went away\n\s+at /),
    }),
  );
});
