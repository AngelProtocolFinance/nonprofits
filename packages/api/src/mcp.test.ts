import type { Client as DataClient } from "@libsql/client";
import {
  Client,
  type ClientOptions,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  freshClient,
  insertKey,
  type TestApi,
  type TestApiOptions,
  testApi,
} from "./test-support.ts";

const MINUTE_MS = 60_000;

let api: TestApi;
const clients: Client[] = [];

async function start(options?: TestApiOptions) {
  api = await testApi(options);
  return api;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.close();
  await api.dispose();
});

/** A REST response's JSON, from a keyless client no other request comes from unless `headers` says otherwise. */
async function restJson<T = unknown>(
  path: string,
  headers: Record<string, string> = freshClient(),
): Promise<T> {
  return (await api.app.request(path, { headers })).json() as Promise<T>;
}

/** An MCP client connected to the app's `/mcp`, sending `headers` on every request. */
async function connect(
  headers: Record<string, string>,
  options?: ClientOptions,
): Promise<Client> {
  const client = new Client({ name: "mcp-test", version: "1.0.0" }, options);
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      requestInit: { headers },
      fetch: async (url, init) => api.app.request(url, init),
    }),
  );
  return client;
}

/** Headers from a whitelisted key whose limits no test here reaches, unless `limits` are given. */
async function keyed(
  limits = { daily: 1000, perMinute: 1000 },
): Promise<Record<string, string>> {
  const { key } = await insertKey(api, { limits });
  return { ...freshClient(), authorization: `Bearer ${key}` };
}

/** A name with no address on record, for a search match that has no place. */
async function placelessMatch(data: DataClient) {
  await data.batch(
    [
      "INSERT INTO orgs (ein, name, name_run_id) VALUES ('581771391', 'RED CROSS CIVITANS', 1)",
      "INSERT INTO orgs_fts (rowid, name) VALUES (581771391, 'RED CROSS CIVITANS')",
    ],
    "write",
  );
}

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

/** The requests `subject`'s daily quota has counted on the test clock's UTC day. */
async function requestsToday(subject: string): Promise<number> {
  const found = await api.appDb.client.execute({
    sql: "SELECT requests FROM key_usage WHERE subject = ?1 AND day = ?2",
    args: [subject, api.clock.now().toISOString().slice(0, 10)],
  });
  return Number(found.rows[0]?.requests ?? 0);
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
function post(message: unknown, headers: Record<string, string>) {
  return api.app.request("/mcp", {
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
    await start();
    const badKey = { authorization: `Bearer npk_${"x".repeat(64)}` };
    const rest = await restJson("/v1/orgs/530196605", {
      ...freshClient(),
      ...badKey,
    });

    const response = await post(INITIALIZE, { ...freshClient(), ...badKey });

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
    await start();
    // app.request serves on localhost: the host the request's own URL names
    const own = await post(INITIALIZE, {
      ...freshClient(),
      origin: "http://localhost",
    });
    expect(own.status).toBe(200);

    const response = await post(INITIALIZE, {
      ...freshClient(),
      origin: "https://evil.example",
    });

    expect(response.status).toBe(403);
  });

  test("refuses a body whose Content-Length is past 16384 bytes with a 413 problem, before reading it", async () => {
    await start();

    const response = await api.app.request("/mcp", {
      method: "POST",
      headers: {
        ...freshClient(),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "content-length": "16385",
      },
      body: JSON.stringify(INITIALIZE),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "body_too_large" });
  });

  test("refuses a body far past any tool call's arguments with a 413 problem", async () => {
    await start();

    const response = await post(
      { ...INITIALIZE, padding: "x".repeat(20_000) },
      freshClient(),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toStrictEqual({
      type: "about:blank",
      title: "Content Too Large",
      status: 413,
      code: "body_too_large",
      detail: "An MCP request body is at most 16384 bytes.",
    });
  });

  test("refuses subscriptions/listen with a JSON-RPC error: the tools never change, so no stream is held open", async () => {
    await start();
    const client = await connect(freshClient(), {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    });

    await expect(
      client.listen({ toolsListChanged: true }, { timeout: 5_000 }),
    ).rejects.toThrow(/subscriptions\/listen is not offered/);
  });

  test("answers a 2025-era tools/call sent without a session, as Claude Code sends it", async () => {
    await start();
    const headers = await keyed();
    const rest = await restJson("/v1/orgs/530196605", headers);

    const response = await post(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "lookup_nonprofit", arguments: { ein: "53-0196605" } },
      },
      { ...headers, "mcp-protocol-version": "2025-06-18" },
    );

    expect(response.status).toBe(200);
    expect(await rpcResponses(response)).toMatchObject([
      { result: { structuredContent: rest } },
    ]);
  });

  test("a message the SDK rejects is logged as one structured error line", async () => {
    await start();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      // names the 2026 revision, but the body lacks its per-request envelope
      { ...freshClient(), "mcp-protocol-version": "2026-07-28" },
    );

    const lines = errors.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(response.status).toBe(400);
    expect(lines).toContainEqual(
      expect.objectContaining({
        event: "mcp_error",
        cause: expect.any(String),
      }),
    );
  });

  test("a request whose body fails mid-read answers the 500 problem and logs the cause", async () => {
    await start();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = new ReadableStream({
      pull: (controller) => controller.error(new Error("client went away")),
    });

    const response = await api.app.request("/mcp", {
      method: "POST",
      headers: {
        ...freshClient(),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body,
      duplex: "half",
    } as RequestInit);

    const lines = errors.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(response.status).toBe(500);
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
      }),
    );
  });

  test("answers 405 to GET: no server-sent event stream is offered", async () => {
    await start();

    const response = await api.app.request("/mcp", { headers: freshClient() });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.json()).toMatchObject({
      code: "method_not_allowed",
      detail: "Use POST.",
    });
  });
});

describe("/mcp with a key", () => {
  test("lists both tools, and lookup_nonprofit and search_nonprofits answer like REST", async () => {
    await start();
    const authorization = `Bearer ${(await insertKey(api)).key}`;
    const headers = { ...freshClient(), authorization };
    const restOrg = await restJson("/v1/orgs/530196605", headers);
    const restSearch = await restJson("/v1/search?q=red%20cross", headers);
    const client = await connect(headers);

    const { tools } = await client.listTools();
    const lookup = await client.callTool({
      name: "lookup_nonprofit",
      arguments: { ein: "530196605" },
    });
    const search = await client.callTool({
      name: "search_nonprofits",
      arguments: { query: "red cross" },
    });

    expect(tools.map((tool) => tool.name).sort()).toStrictEqual([
      "lookup_nonprofit",
      "search_nonprofits",
    ]);
    expect(restOrg).toMatchObject({ name: "AMERICAN NATIONAL RED CROSS" });
    expect(lookup.structuredContent).toStrictEqual(restOrg);
    expect(search.structuredContent).toStrictEqual(restSearch);
  });

  test.each([
    { ein: 530196605, rest: "/v1/orgs/530196605" },
    { ein: 1234567, rest: "/v1/orgs/001234567" },
  ])(
    "lookup_nonprofit reads the number $ein as the 9-digit EIN it zero-pads to",
    async ({ ein, rest }) => {
      await start();
      const headers = await keyed();
      const expected = await restJson(rest, headers);
      const client = await connect(headers);

      const result = await client.callTool({
        name: "lookup_nonprofit",
        arguments: { ein },
      });

      expect(result.structuredContent).toStrictEqual(expected);
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
      await start();
      const headers = await keyed();
      const rest = await restJson(`/v1/orgs/${ein}`, headers);
      const client = await connect(headers);

      const result = await client.callTool({
        name: "lookup_nonprofit",
        arguments: { ein },
      });

      expect(result.content).toStrictEqual([
        { type: "text", text: text.join("\n") },
        { type: "text", text: JSON.stringify(rest) },
      ]);
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
      await start({ fill: placelessMatch });
      const headers = await keyed();
      const rest = await restJson(
        `/v1/search?q=${encodeURIComponent(query)}`,
        headers,
      );
      const client = await connect(headers);

      const result = await client.callTool({
        name: "search_nonprofits",
        arguments: { query },
      });

      expect(result.content).toStrictEqual([
        { type: "text", text: text.join("\n") },
        { type: "text", text: JSON.stringify(rest) },
      ]);
    },
  );

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
      await start();
      const headers = await keyed();
      const problem = await restJson<{ code: string; detail: string }>(
        rest,
        headers,
      );
      const client = await connect(headers);

      const result = await client.callTool({ name: tool, arguments: args });

      expect(problem.code).toBe(code);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toStrictEqual(problem);
      expect(result.content).toStrictEqual([
        { type: "text", text: `${code}: ${problem.detail}` },
      ]);
    },
  );

  test("a data read that fails behind a tool call is a tool error carrying the REST 503 problem", async () => {
    await start({
      fill: async (data) => {
        await data.execute("DROP TABLE programs");
      },
    });
    const client = await connect(await keyed());

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
  });

  test("a batch POST of 6 tool calls is metered 6 times: the 6th is past a 5-a-day key's quota", async () => {
    await start();
    const headers = await keyed({ daily: 5, perMinute: 100 });
    const batch = [1, 2, 3, 4, 5, 6].map((id) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "lookup_nonprofit", arguments: { ein: "530196605" } },
    }));

    const response = await post(batch, {
      ...headers,
      "mcp-protocol-version": "2025-03-26",
    });

    type ToolResult = {
      result: { isError?: boolean; structuredContent: { code?: string } };
    };
    const outcomes = ((await rpcResponses(response)) as ToolResult[])
      .map(({ result }) =>
        result.isError ? result.structuredContent.code : "served",
      )
      .sort();
    expect(outcomes).toStrictEqual([
      "daily_quota_exceeded",
      "served",
      "served",
      "served",
      "served",
      "served",
    ]);
  });

  test("one lookup over MCP and one over REST leave the key's daily count at 2: the handshake and tool listing count none", async () => {
    await start();
    const key = await insertKey(api);
    const headers = { ...freshClient(), authorization: `Bearer ${key.key}` };
    await restJson("/v1/orgs/530196605", headers);
    const client = await connect(headers);
    await client.listTools();

    await client.callTool({
      name: "lookup_nonprofit",
      arguments: { ein: "530196605" },
    });

    expect(await requestsToday(key.id)).toBe(2);
  });
});

describe("/mcp without a key", () => {
  test("lists lookup_nonprofit and search_nonprofits", async () => {
    await start();
    const client = await connect(freshClient());

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toStrictEqual([
      "lookup_nonprofit",
      "search_nonprofits",
    ]);
  });

  test("lookup_nonprofit answers 530196605 with the same JSON as GET /v1/orgs/530196605", async () => {
    await start();
    const rest = await restJson("/v1/orgs/530196605");
    const client = await connect(freshClient());

    const result = await client.callTool({
      name: "lookup_nonprofit",
      arguments: { ein: "530196605" },
    });

    expect(rest).toMatchObject({ name: "AMERICAN NATIONAL RED CROSS" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toStrictEqual(rest);
  });

  test('search_nonprofits answers "red cross" with the same matches as GET /v1/search?q=red cross', async () => {
    await start();
    const rest = await restJson<{ results: unknown[] }>(
      "/v1/search?q=red%20cross",
    );
    const client = await connect(freshClient());

    const result = await client.callTool({
      name: "search_nonprofits",
      arguments: { query: "red cross" },
    });

    expect(rest.results.length).toBeGreaterThan(0);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toStrictEqual(rest);
  });

  test("shares an IP's per-minute limit with REST: after a REST lookup, a tool call is a 429 tool error with its retry seconds", async () => {
    await start();
    const ip = freshClient();
    await restJson("/v1/orgs/530196605", ip);
    const client = await connect(ip);

    const result = await client.callTool({
      name: "search_nonprofits",
      arguments: { query: "red cross" },
    });

    const detail =
      "Requests without an API key are limited to 1 request per minute per IP address. Retry in 60 seconds. An API key lifts this limit: ask the operator for one.";
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toStrictEqual({
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      code: "per_minute_limit_exceeded",
      detail,
      retryAfterSeconds: 60,
    });
    expect(result.content).toStrictEqual([
      { type: "text", text: `per_minute_limit_exceeded: ${detail}` },
    ]);
  });

  test("tool calls and REST requests from one IP share its 5 a day: past them a call is a tool error carrying the 429 problem and its retry seconds", async () => {
    await start();
    api.clock.set("2026-10-05T22:00:00Z");
    const ip = freshClient();
    const call = { name: "lookup_nonprofit", arguments: { ein: "530196605" } };
    for (let i = 1; i <= 2; i++) {
      await restJson("/v1/orgs/530196605", ip);
      api.clock.advance(MINUTE_MS);
    }
    for (let i = 1; i <= 3; i++) {
      const client = await connect(ip);
      await client.listTools();
      expect((await client.callTool(call)).isError, `call ${i}`).toBeFalsy();
      api.clock.advance(MINUTE_MS);
    }
    const client = await connect(ip);

    const result = await client.callTool(call);

    const detail =
      "Requests without an API key are limited to 5 requests a UTC day per IP address, and this address has used them. They reset at 2026-10-06T00:00:00Z (UTC midnight). An API key lifts this limit: ask the operator for one.";
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toStrictEqual({
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      code: "daily_quota_exceeded",
      detail,
      retryAfterSeconds: 6900,
    });
    expect(result.content).toStrictEqual([
      { type: "text", text: `daily_quota_exceeded: ${detail}` },
    ]);
  });
});

describe("/mcp protocol traffic", () => {
  test("is bounded per client without a key: past 60 requests in a minute the next is a 429 problem before any MCP message is read", async () => {
    await start();
    api.clock.set("2026-10-05T12:00:00Z");
    const ip = freshClient();
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
    expect((await post(INITIALIZE, freshClient())).status).toBe(200);
    api.clock.advance(MINUTE_MS);
    expect((await post(INITIALIZE, ip)).status).toBe(200);
  });

  test("holds no client with a key to the keyless cap", async () => {
    await start();
    const headers = {
      ...freshClient(),
      authorization: `Bearer ${(await insertKey(api)).key}`,
    };
    for (let i = 1; i <= 60; i++) await post(INITIALIZE, headers);

    expect((await post(INITIALIZE, headers)).status).toBe(200);
  });
});
