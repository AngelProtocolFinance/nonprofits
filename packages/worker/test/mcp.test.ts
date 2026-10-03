import {
  Client,
  type ClientOptions,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startOfBurstWindow } from "./clock-windows.ts";
import {
  createWorkerHarness,
  type Harness,
  issueWhitelistedKey,
  listenSeeded,
} from "./harness.ts";

const server = createWorkerHarness();
let authorization: string;

beforeAll(async () => {
  await listenSeeded(server, async (db) => {
    // a name with no address on record, for a search match that has no place
    await db
      .prepare(
        "INSERT INTO orgs (ein, name, name_run_id) VALUES ('581771391', 'RED CROSS CIVITANS', 1)",
      )
      .bind()
      .all();
  });
  authorization = `Bearer ${(await issueWhitelistedKey(server)).key}`;
});

afterAll(async () => {
  await server.close();
});

const MCP_URL = new URL("http://localhost/mcp");

/** An MCP client connected to `/mcp` through the harness, sending `headers` on every request. */
async function connect(
  headers: Record<string, string>,
  options?: ClientOptions,
): Promise<Client> {
  const client = new Client({ name: "mcp-test", version: "1.0.0" }, options);
  await client.connect(
    new StreamableHTTPClientTransport(MCP_URL, {
      requestInit: { headers },
      // the client types init with node's global fetch, the harness with undici's
      fetch: (url, init) =>
        server.fetch(String(url), init as Parameters<Harness["fetch"]>[1]),
    }),
  );
  return client;
}

/** A REST response's JSON, read at once: the harness can drop a body left unread across other requests. */
async function restJson<T = unknown>(
  path: string,
  headers: Record<string, string> = { authorization },
): Promise<T> {
  return (await server.fetch(path, { headers })).json() as Promise<T>;
}

/** The `result` of a JSON-RPC response sent as JSON or as one server-sent event. */
async function rpcResult(response: Response): Promise<unknown> {
  const text = await response.text();
  const json = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join("")
    : text;
  return (JSON.parse(json) as { result: unknown }).result;
}

/** The 2025-era handshake Claude Code and MCP Inspector open with. */
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw-test", version: "1.0.0" },
  },
};

/** One JSON-RPC message POSTed to `/mcp` as a streamable HTTP client sends it. */
function post(
  message: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return server.fetch("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(message),
  });
}

describe("/mcp before the handshake", () => {
  test("refuses an unrecognized key with the REST 401 problem and challenge, before any MCP message is read", async () => {
    const badKey = { authorization: `Bearer npk_${"x".repeat(64)}` };
    const rest = await restJson("/v1/orgs/530196605", badKey);

    const response = await post(INITIALIZE, badKey);

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer realm="nonprofits", error="invalid_token"',
    );
    expect(await response.json()).toStrictEqual(rest);
  });
});

describe("/mcp transport", () => {
  test("refuses a request a page on another site sent: 403 for a foreign Origin, while the server's own Origin is served", async () => {
    // the harness serves on 127.0.0.1: the host the request's own URL names
    const own = await post(INITIALIZE, {
      authorization,
      origin: "http://127.0.0.1",
    });
    expect(own.status).toBe(200);
    expect(await rpcResult(own)).toMatchObject({
      serverInfo: { name: "nonprofits" },
    });

    const response = await post(INITIALIZE, {
      authorization,
      origin: "https://evil.example",
    });

    expect(response.status).toBe(403);
  });

  test("answers 405 to GET: no server-sent event stream is offered", async () => {
    const response = await server.fetch("/mcp", { headers: { authorization } });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  test("refuses a body far past any tool call's arguments with 413, unread", async () => {
    const response = await post(
      { ...INITIALIZE, padding: "x".repeat(20_000) },
      { authorization },
    );

    expect(response.status).toBe(413);
  });

  test("answers a 2025-era tools/call sent without a session, as Claude Code sends it", async () => {
    const rest = await restJson("/v1/orgs/530196605");

    const response = await post(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "lookup_nonprofit", arguments: { ein: "53-0196605" } },
      },
      { authorization, "mcp-protocol-version": "2025-06-18" },
    );

    expect(response.status).toBe(200);
    expect(await rpcResult(response)).toMatchObject({
      structuredContent: rest,
    });
  });
});

describe("/mcp with a key", () => {
  test("refuses subscriptions/listen with a JSON-RPC error: the tools never change, so no stream is held open", async () => {
    const client = await connect(
      { authorization },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );

    await expect(
      client.listen({ toolsListChanged: true }, { timeout: 5_000 }),
    ).rejects.toThrow(/subscriptions\/listen is not offered/);
    await client.close();
  });

  test("lists lookup_nonprofit and search_nonprofits", async () => {
    const client = await connect({ authorization });

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toStrictEqual([
      "lookup_nonprofit",
      "search_nonprofits",
    ]);
    await client.close();
  });

  test("lookup_nonprofit answers 530196605 with the same JSON as GET /v1/orgs/530196605", async () => {
    const rest = await restJson("/v1/orgs/530196605");
    const client = await connect({ authorization });

    const result = await client.callTool({
      name: "lookup_nonprofit",
      arguments: { ein: "530196605" },
    });

    expect(rest).toMatchObject({ ein: "530196605" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toStrictEqual(rest);
    await client.close();
  });

  test.each([
    { ein: 530196605, rest: "/v1/orgs/530196605" },
    { ein: 1234567, rest: "/v1/orgs/001234567" },
  ])(
    "lookup_nonprofit reads the number $ein as the 9-digit EIN it zero-pads to",
    async ({ ein, rest }) => {
      const expected = await restJson(rest);
      const client = await connect({ authorization });

      const result = await client.callTool({
        name: "lookup_nonprofit",
        arguments: { ein },
      });

      expect(result.structuredContent).toStrictEqual(expected);
      await client.close();
    },
  );

  test.each([
    {
      ein: "530196605",
      text: [
        "AMERICAN NATIONAL RED CROSS, EIN 530196605, WASHINGTON, DC",
        "501(c)(3): yes. Tax-deductible (Pub 78): yes. Revoked: no.",
        "Mission: The American Red Cross prevents and alleviates human suffering in the face of emergencies by mobilizing the power of volunteers and the generosity of donors.",
        "Website: https://www.redcross.org",
      ],
    },
    {
      // a 990-N filer: no mission on record, and a note saying why
      ein: "271234567",
      text: [
        "SUNNYSIDE YOUTH SOCCER LEAGUE, EIN 271234567, BOISE, ID",
        "501(c)(3): yes. Tax-deductible (Pub 78): yes. Revoked: no.",
        "Mission: none on record",
        "Website: sunnysidesoccer.example",
        "Notes: 990-N filer: no mission on record",
      ],
    },
    {
      // revoked and gone from the BMF: its 501(c)(3) status is unknown
      ein: "311234567",
      text: [
        "DEFUNCT ARTS COUNCIL, EIN 311234567, TOLEDO, OH",
        "501(c)(3): unknown. Tax-deductible (Pub 78): no. Revoked: yes.",
        "Mission: none on record",
        "Notes: revoked; not in the current BMF; no e-filed 990 in the last 3 release years; no website on record",
      ],
    },
  ])(
    "lookup_nonprofit tells $ein in text for a client that reads only text, then the JSON",
    async ({ ein, text }) => {
      const rest = await restJson(`/v1/orgs/${ein}`);
      const client = await connect({ authorization });

      const result = await client.callTool({
        name: "lookup_nonprofit",
        arguments: { ein },
      });

      expect(result.content).toStrictEqual([
        { type: "text", text: text.join("\n") },
        { type: "text", text: JSON.stringify(rest) },
      ]);
      await client.close();
    },
  );

  test.each([
    {
      query: "red cross",
      text: [
        'Matches for "red cross", best first:',
        "1. AMERICAN NATIONAL RED CROSS, EIN 530196605, WASHINGTON, DC",
        // no address on record: no place after the EIN
        "2. RED CROSS CIVITANS, EIN 581771391",
      ],
    },
    { query: "zzzz qqqq", text: ['No matches for "zzzz qqqq".'] },
  ])(
    "search_nonprofits tells the matches for $query in text, then the JSON",
    async ({ query, text }) => {
      const rest = await restJson(`/v1/search?q=${encodeURIComponent(query)}`);
      const client = await connect({ authorization });

      const result = await client.callTool({
        name: "search_nonprofits",
        arguments: { query },
      });

      expect(result.content).toStrictEqual([
        { type: "text", text: text.join("\n") },
        { type: "text", text: JSON.stringify(rest) },
      ]);
      await client.close();
    },
  );

  test('search_nonprofits answers "red cross" with the same matches as GET /v1/search?q=red cross', async () => {
    const rest = await restJson<{ results: unknown[] }>(
      "/v1/search?q=red%20cross",
    );
    const client = await connect({ authorization });

    const result = await client.callTool({
      name: "search_nonprofits",
      arguments: { query: "red cross" },
    });

    expect(rest.results.length).toBeGreaterThan(0);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toStrictEqual(rest);
    await client.close();
  });

  test.each([
    {
      code: "invalid_ein",
      rest: "/v1/orgs/12-34",
      tool: "lookup_nonprofit",
      args: { ein: "12-34" },
    },
    {
      code: "not_found",
      rest: "/v1/orgs/999999999",
      tool: "lookup_nonprofit",
      args: { ein: "999999999" },
    },
    {
      code: "invalid_query",
      rest: "/v1/search?q=a",
      tool: "search_nonprofits",
      args: { query: "a" },
    },
    {
      code: "invalid_limit",
      rest: "/v1/search?q=red&limit=0",
      tool: "search_nonprofits",
      args: { query: "red", limit: 0 },
    },
  ])(
    "$tool answers $code as a tool error carrying the REST problem",
    async ({ code, rest, tool, args }) => {
      const problem = await restJson<{ code: string; detail: string }>(rest);
      const client = await connect({ authorization });

      const result = await client.callTool({ name: tool, arguments: args });

      expect(problem.code).toBe(code);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toStrictEqual(problem);
      expect(result.content).toStrictEqual([
        { type: "text", text: `${code}: ${problem.detail}` },
      ]);
      await client.close();
    },
  );
});

describe("/mcp without a key", () => {
  test("serves a keyless client: the handshake is not counted, and a tool call answers like REST", async () => {
    const ip = { "cf-connecting-ip": "198.51.100.10" };
    const rest = await restJson("/v1/orgs/530196605");
    const client = await connect(ip);
    await client.listTools();

    const result = await client.callTool({
      name: "lookup_nonprofit",
      arguments: { ein: "530196605" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toStrictEqual(rest);
    await client.close();
  });
});

describe("/mcp protocol traffic", () => {
  test("is bounded per client without a key: past 60 requests in a minute the next is a 429 problem before any MCP message is read", async () => {
    const ip = { "cf-connecting-ip": "198.51.100.12" };
    // the one test of the real binding; the refusal and the keyed exemption are in direct/mcp.test.ts
    await startOfBurstWindow(61, () =>
      post(INITIALIZE, { "cf-connecting-ip": "198.51.100.14" }),
    );
    for (let i = 1; i <= 60; i++) {
      expect((await post(INITIALIZE, ip)).status, `request ${i}`).toBe(200);
    }

    const response = await post(INITIALIZE, ip);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toStrictEqual({
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      code: "per_minute_limit_exceeded",
      detail:
        "HTTP requests to /mcp without an API key are limited to 60 per minute per IP address, whatever MCP messages each carries. Retry in 60 seconds. An API key lifts this limit: ask the operator for one.",
    });
  });
});
