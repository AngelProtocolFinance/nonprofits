import { afterEach, describe, expect, test, vi } from "vitest";
import {
  FIREWALL_RATE_LIMIT_IDS,
  type FirewallCheck,
  firewallLimiters,
  firewallRateLimiter,
  type Limiters,
} from "./firewall-limiter.ts";
import { ROWS_WRITTEN } from "./quota.ts";
import {
  failingDb,
  freshClient,
  insertKey,
  rowsWrittenBy,
  type TestApi,
  type TestApiOptions,
  testApi,
  usageRows,
} from "./test-support.ts";

let api: TestApi;

async function start(options?: TestApiOptions) {
  api = await testApi(options);
  return api;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await api.dispose();
});

type Verdict = Awaited<ReturnType<FirewallCheck>> | Error;

/**
 * A Firewall that answers each rule with its verdict in `verdicts` (not
 * limited when absent) and records every check it was asked.
 */
function stubFirewall(verdicts: Partial<Record<keyof Limiters, Verdict>>) {
  const checks: { rateLimitId: string; rateLimitKey: string }[] = [];
  const check: FirewallCheck = async (rateLimitId, { rateLimitKey }) => {
    checks.push({ rateLimitId, rateLimitKey });
    const limiter = (
      Object.keys(FIREWALL_RATE_LIMIT_IDS) as (keyof Limiters)[]
    ).find((name) => FIREWALL_RATE_LIMIT_IDS[name] === rateLimitId);
    const verdict = limiter && verdicts[limiter];
    if (verdict instanceof Error) throw verdict;
    return verdict ?? { rateLimited: false };
  };
  return { limiters: firewallLimiters(check), checks };
}

function lookup(headers: Record<string, string>) {
  return api.app.request("/v1/orgs/530196605", { headers });
}

function mcpInitialize(headers: Record<string, string>) {
  return api.app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "firewall-test", version: "1.0.0" },
      },
    }),
  });
}

/** A request with a key no other request sends, and that key's id. */
async function keyedLookup(api: TestApi) {
  const { id, key } = await insertKey(api);
  const response = await lookup({
    ...freshClient(),
    authorization: `Bearer ${key}`,
  });
  return { response, keyId: id };
}

/**
 * Each limiter, a request that reaches it with every limiter before it
 * passing, and what its rule is asked to count that request against: the
 * key's id, or the client's `ip:` subject.
 */
const LIMITED: {
  limiter: keyof Limiters;
  send: (api: TestApi) => Promise<{ response: Response; keyId?: string }>;
  bucket: "key" | "client";
  detail: string;
}[] = [
  {
    limiter: "keylessBurst",
    send: async () => ({ response: await lookup(freshClient()) }),
    bucket: "client",
    detail:
      "Requests without an API key are limited to 1 request per minute per IP address. Retry in 60 seconds. An API key lifts this limit: ask the operator for one.",
  },
  {
    limiter: "keyBurst",
    send: keyedLookup,
    bucket: "key",
    detail:
      "This key's limit of 10 requests per minute is reached. Retry in 60 seconds.",
  },
  {
    limiter: "keyedRequests",
    send: keyedLookup,
    bucket: "client",
    detail:
      "Requests with an API key from one client are limited to 600 requests per minute. Retry in 60 seconds.",
  },
  {
    limiter: "keylessMcpRequests",
    send: async () => ({ response: await mcpInitialize(freshClient()) }),
    bucket: "client",
    detail:
      "HTTP requests to /mcp without an API key are limited to 60 per minute per IP address, whatever MCP messages each carries. Retry in 60 seconds. An API key lifts this limit: ask the operator for one.",
  },
];

describe("the per-minute limiters on Vercel Firewall rules, the Firewall stubbed", () => {
  test.each(LIMITED)(
    "$limiter refused: the request is a 429 with the in-memory limiter's code, message and Retry-After, counted nowhere",
    async ({ limiter, send, bucket, detail }) => {
      const firewall = stubFirewall({ [limiter]: { rateLimited: true } });
      await start({ limiters: firewall.limiters });

      const { response, keyId } = await send(api);

      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(await response.json()).toStrictEqual({
        type: "about:blank",
        title: "Too Many Requests",
        status: 429,
        code: "per_minute_limit_exceeded",
        detail,
      });
      const asked = firewall.checks.find(
        (c) => c.rateLimitId === FIREWALL_RATE_LIMIT_IDS[limiter],
      );
      if (bucket === "key") expect(asked?.rateLimitKey).toBe(keyId);
      else expect(asked?.rateLimitKey).toMatch(/^ip:/);
      expect(await usageRows(api)).toBe(0);
    },
  );

  test("a client over the keyed-request rule is refused before its key is read", async () => {
    const firewall = stubFirewall({ keyedRequests: { rateLimited: true } });
    await start({
      limiters: firewall.limiters,
      appDbAs: (db) => failingDb(db, /apikey/),
    });

    const response = await lookup({
      ...freshClient(),
      authorization: `Bearer npk_${"Q".repeat(64)}`,
    });

    expect(response.status).toBe(429);
    expect(firewall.checks.map((c) => c.rateLimitId)).toStrictEqual([
      FIREWALL_RATE_LIMIT_IDS.keyedRequests,
    ]);
  });

  test("a served request writes the rows it writes over the in-memory limiters", async () => {
    await start({ limiters: stubFirewall({}).limiters });

    const keyless = await rowsWrittenBy(api, () => lookup(freshClient()));
    const { key } = await insertKey(api);
    const keyed = await rowsWrittenBy(api, () =>
      lookup({ ...freshClient(), authorization: `Bearer ${key}` }),
    );

    expect([keyless, keyed]).toStrictEqual([
      ROWS_WRITTEN.metered,
      ROWS_WRITTEN.metered,
    ]);
  });
});

describe("a limiter that can't answer fails closed", () => {
  const FAILURES: [string, Verdict][] = [
    ["its rule isn't published", { rateLimited: false, error: "not-found" }],
    ["the Firewall blocks the check", { rateLimited: true, error: "blocked" }],
    ["the check call fails", new Error("fetch failed")],
  ];
  const CASES = LIMITED.flatMap(({ limiter, send }) =>
    FAILURES.map(([failure, verdict]) => ({ limiter, send, failure, verdict })),
  );

  test.each(CASES)(
    "$limiter, when $failure: a 503 auth_unavailable problem, never a pass, counted nowhere",
    async ({ limiter, send, verdict }) => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      await start({ limiters: stubFirewall({ [limiter]: verdict }).limiters });

      const { response } = await send(api);

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBeNull();
      expect(await response.json()).toMatchObject({ code: "auth_unavailable" });
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('"event":"auth_unavailable"'),
      );
      expect(await usageRows(api)).toBe(0);
    },
  );
});

describe("off Vercel, the SDK-backed limiters call nothing", () => {
  test.each(["test", "development", undefined])(
    "under NODE_ENV=%s a check throws before any request, where the SDK would pass it unasked",
    async (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      const fetched = vi.spyOn(globalThis, "fetch");

      await expect(
        firewallRateLimiter("keyless-burst").limit({ key: "ip:x" }),
      ).rejects.toThrow('NODE_ENV is not "production"');
      expect(fetched).not.toHaveBeenCalled();
    },
  );

  test("under NODE_ENV=production with no Vercel request context a check throws before any request", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fetched = vi.spyOn(globalThis, "fetch");

    await expect(
      firewallRateLimiter("keyless-burst").limit({ key: "ip:x" }),
    ).rejects.toThrow("`headers` or `request` options are required");
    expect(fetched).not.toHaveBeenCalled();
  });

  test("the app over them refuses a request with 503 auth_unavailable and makes no call", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetched = vi.spyOn(globalThis, "fetch");
    await start({ limiters: firewallLimiters() });

    const response = await lookup(freshClient());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "auth_unavailable" });
    expect(fetched).not.toHaveBeenCalled();
  });
});
