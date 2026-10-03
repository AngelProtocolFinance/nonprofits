import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createTestHarness } from "wrangler";
import { lookup, search } from "../../src/handlers.ts";
import { startOfMinuteWindow } from "../clock-windows.ts";
import { emptyServedData } from "./empty-data.ts";
import { noBurstLimit } from "./limiters.ts";
import { noCaches } from "./no-cache.ts";

// typed against the Worker's globals, not node's: this file imports Worker source
const ADMIN_TOKEN = "test-only-admin-token-0123456789abcdef";
const server = createTestHarness({
  workers: [
    {
      configPath: new URL("../../wrangler.jsonc", import.meta.url),
      secrets: {
        BETTER_AUTH_SECRET: "test-only-better-auth-secret-0123456789abcdef",
        ADMIN_TOKEN,
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

function adminFetch(method: string, path: string, body: unknown = {}) {
  return server.fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function issueKey(): Promise<{ id: string; key: string }> {
  const response = await adminFetch("POST", "/admin/keys", {
    email: "owner@example.org",
  });
  return (await response.json()) as { id: string; key: string };
}

/** The outcome of a lookup with `credential`; the served data DB holds no orgs, so an admitted one is `not_found`. */
async function lookupWith(
  env: Env,
  credential: string,
  now = new Date().toISOString(),
) {
  const result = await lookup("530196605", {
    env,
    credential,
    clientIp: null,
    cfWorker: null,
    now: new Date(now),
  });
  return result.ok ? "ok" : result.error;
}

test("a default key's 11th request inside a minute is 429 per_minute_limit_exceeded", async () => {
  const { key } = await issueKey();
  await startOfMinuteWindow();

  for (let i = 1; i <= 10; i++) {
    expect(await lookupWith(env, key), `request ${i}`).toMatchObject({
      code: "not_found",
    });
  }
  expect(await lookupWith(env, key)).toStrictEqual({
    code: "per_minute_limit_exceeded",
    message:
      "This key's limit of 10 requests per minute is reached. Retry in 60 seconds.",
    retryAfterSeconds: 60,
  });
}, 30_000);

async function whitelistedKey(daily: number, perMinute: number) {
  const issued = await issueKey();
  await adminFetch("PUT", `/admin/keys/${issued.id}/limits`, {
    daily,
    perMinute,
  });
  return issued;
}

test("a whitelisted key's 11th request inside a minute is served: the burst binding is the default tier's", async () => {
  const { key } = await whitelistedKey(500, 60);
  await startOfMinuteWindow();

  for (let i = 1; i <= 11; i++) {
    expect(await lookupWith(env, key), `request ${i}`).toMatchObject({
      code: "not_found",
    });
  }
}, 30_000);

/** The Worker's env with default-tier keys' service-wide daily limit set to `limit`. */
function withKeyCeiling(limit: number, overrides: Partial<Env> = {}): Env {
  return { ...env, SERVICE_KEY_DAILY_LIMIT: limit, ...overrides };
}

test("past the service-wide daily limit, the next default-tier request across two keys is 429; a whitelisted key is still served", async () => {
  const limited = withKeyCeiling(5);
  const first = await issueKey();
  const second = await issueKey();
  const whitelisted = await whitelistedKey(500, 60);
  const now = "2026-11-01T12:00:00Z";

  for (const { key } of [first, second, first, second, first]) {
    expect(await lookupWith(limited, key, now)).toMatchObject({
      code: "not_found",
    });
  }
  expect(await lookupWith(limited, second.key, now)).toStrictEqual({
    code: "service_daily_limit_reached",
    message:
      "The service-wide daily limit for default-tier keys is reached. It resets at 2026-11-02T00:00:00Z (UTC midnight). Keys with their own limits from the operator are not affected.",
    retryAfterSeconds: 43_200,
  });
  expect(await lookupWith(limited, whitelisted.key, now)).toMatchObject({
    code: "not_found",
  });
});

test("a request refused by its own daily quota does not count toward the service-wide limit", async () => {
  const limited = withKeyCeiling(52, { KEY_BURST_LIMITER: noBurstLimit });
  const spent = await issueKey();
  const other = await issueKey();
  const now = "2026-11-02T12:00:00Z";
  for (let i = 1; i <= 50; i++) await lookupWith(limited, spent.key, now);

  for (let i = 1; i <= 3; i++) {
    expect(await lookupWith(limited, spent.key, now)).toMatchObject({
      code: "daily_quota_exceeded",
    });
  }

  // 50 of 52 used: the three refusals left two for another key
  expect(await lookupWith(limited, other.key, now)).toMatchObject({
    code: "not_found",
  });
  expect(await lookupWith(limited, other.key, now)).toMatchObject({
    code: "not_found",
  });
  expect(await lookupWith(limited, other.key, now)).toMatchObject({
    code: "service_daily_limit_reached",
  });
}, 30_000);

test("a request refused by the service-wide limit does not count toward its key's daily quota", async () => {
  const unlimitedBursts = { KEY_BURST_LIMITER: noBurstLimit };
  const { key } = await issueKey();
  const now = "2026-11-03T12:00:00Z";
  for (let i = 1; i <= 5; i++) {
    await lookupWith(withKeyCeiling(5, unlimitedBursts), key, now);
  }
  for (let i = 1; i <= 3; i++) {
    expect(
      await lookupWith(withKeyCeiling(5, unlimitedBursts), key, now),
    ).toMatchObject({ code: "service_daily_limit_reached" });
  }

  // the operator raises the service limit: the key still has 45 of its 50
  const raised = withKeyCeiling(1000, unlimitedBursts);
  for (let i = 1; i <= 45; i++) {
    expect(await lookupWith(raised, key, now), `request ${i}`).toMatchObject({
      code: "not_found",
    });
  }
  expect(await lookupWith(raised, key, now)).toMatchObject({
    code: "daily_quota_exceeded",
  });
}, 30_000);

/** A keyless lookup from `clientIp` at `now`, sent by the Worker named in `cfWorker` if any. */
async function keylessLookup(
  env: Env,
  clientIp: string | null,
  now: string,
  cfWorker: string | null = null,
) {
  const result = await lookup("530196605", {
    env,
    credential: null,
    clientIp,
    cfWorker,
    now: new Date(now),
  });
  return result.ok ? "ok" : result.error;
}

test("without a key an IP gets 5 requests a UTC day; the 6th is 429 saying a key lifts the limit, and another IP is still served", async () => {
  const unlimitedBursts = { ...env, KEYLESS_BURST_LIMITER: noBurstLimit };
  const now = "2026-11-04T22:00:00Z";

  for (let i = 1; i <= 5; i++) {
    expect(
      await keylessLookup(unlimitedBursts, "203.0.113.10", now),
      `request ${i}`,
    ).toMatchObject({ code: "not_found" });
  }
  expect(
    await keylessLookup(unlimitedBursts, "203.0.113.10", now),
  ).toStrictEqual({
    code: "daily_quota_exceeded",
    message:
      "Requests without an API key are limited to 5 requests a UTC day per IP address, and this address has used them. They reset at 2026-11-05T00:00:00Z (UTC midnight). An API key lifts this limit: ask the operator for one.",
    retryAfterSeconds: 7200,
  });
  expect(
    await keylessLookup(unlimitedBursts, "203.0.113.11", now),
  ).toMatchObject({ code: "not_found" });
});

test("without a key an IP's 2nd request inside a minute is 429 per_minute_limit_exceeded, saying a key lifts the limit", async () => {
  await startOfMinuteWindow();
  const now = new Date().toISOString();

  expect(await keylessLookup(env, "203.0.113.30", now)).toMatchObject({
    code: "not_found",
  });
  expect(await keylessLookup(env, "203.0.113.30", now)).toStrictEqual({
    code: "per_minute_limit_exceeded",
    message:
      "Requests without an API key are limited to 1 request per minute per IP address. Retry in 60 seconds. An API key lifts this limit: ask the operator for one.",
    retryAfterSeconds: 60,
  });
}, 30_000);

test("without a key, search and lookup count against the same per-IP daily quota", async () => {
  const unlimitedBursts = { ...env, KEYLESS_BURST_LIMITER: noBurstLimit };
  const now = "2026-11-05T08:00:00Z";
  const keylessSearch = async () => {
    const result = await search(
      { query: "red cross" },
      {
        env: unlimitedBursts,
        credential: null,
        clientIp: "203.0.113.40",
        cfWorker: null,
        now: new Date(now),
      },
    );
    return result.ok ? "ok" : result.error.code;
  };

  for (let i = 1; i <= 3; i++) {
    expect(
      await keylessLookup(unlimitedBursts, "203.0.113.40", now),
    ).toMatchObject({ code: "not_found" });
  }
  expect(await keylessSearch()).toBe("ok");
  expect(await keylessSearch()).toBe("ok");

  expect(await keylessSearch()).toBe("daily_quota_exceeded");
});

test("keyless traffic at its service-wide daily limit is 429, saying a key lifts it, while a default key is still served", async () => {
  const limited = {
    ...env,
    SERVICE_KEYLESS_DAILY_LIMIT: 2,
    KEYLESS_BURST_LIMITER: noBurstLimit,
  };
  const { key } = await issueKey();
  const now = "2026-11-06T12:00:00Z";
  await keylessLookup(limited, "203.0.113.50", now);
  await keylessLookup(limited, "203.0.113.51", now);

  expect(await keylessLookup(limited, "203.0.113.52", now)).toStrictEqual({
    code: "service_daily_limit_reached",
    message:
      "The service-wide daily limit for requests without an API key is reached. It resets at 2026-11-07T00:00:00Z (UTC midnight). An API key lifts this limit: ask the operator for one.",
    retryAfterSeconds: 43_200,
  });
  expect(await lookupWith(limited, key, now)).toMatchObject({
    code: "not_found",
  });
});

test("default keys at their service-wide daily limit are 429 while keyless traffic is still served", async () => {
  const limited = withKeyCeiling(2, { KEY_BURST_LIMITER: noBurstLimit });
  const { key } = await issueKey();
  const now = "2026-11-09T12:00:00Z";
  await lookupWith(limited, key, now);
  await lookupWith(limited, key, now);

  expect(await lookupWith(limited, key, now)).toMatchObject({
    code: "service_daily_limit_reached",
  });
  expect(await keylessLookup(limited, "203.0.113.53", now)).toMatchObject({
    code: "not_found",
  });
});

test("a keyless request is counted under a keyed hash of its IP; no usage row holds the IP itself", async () => {
  const ip = "198.51.100.77";
  const day = "2026-11-07";
  await keylessLookup(env, ip, `${day}T12:00:00Z`);

  const { results } = await env.APP_DB.prepare(
    "SELECT * FROM key_usage WHERE day = ?1 AND subject LIKE 'ip:%'",
  )
    .bind(day)
    .all<{ subject: string; requests: number }>();
  expect(results).toMatchObject([
    { subject: expect.stringMatching(/^ip:[0-9a-f]{64}$/), requests: 1 },
  ]);
  const everyRow = await env.APP_DB.prepare("SELECT * FROM key_usage").all();
  expect(JSON.stringify(everyRow.results)).not.toContain(ip);
});

test("keyless requests with no client IP are counted together, not let through", async () => {
  const unlimitedBursts = { ...env, KEYLESS_BURST_LIMITER: noBurstLimit };
  const now = "2026-11-08T12:00:00Z";
  for (let i = 1; i <= 5; i++) {
    expect(await keylessLookup(unlimitedBursts, null, now)).toMatchObject({
      code: "not_found",
    });
  }

  expect(await keylessLookup(unlimitedBursts, null, now)).toMatchObject({
    code: "daily_quota_exceeded",
  });
});

// a var set as text (dashboard, `--var`) arrives as a string, whatever `Env` says
const asVar = (text: string) => text as unknown as number;

test("a service-wide limit that arrives as a string still limits", async () => {
  const limited = withKeyCeiling(asVar("2"), {
    KEY_BURST_LIMITER: noBurstLimit,
  });
  const { key } = await issueKey();
  const now = "2026-11-10T12:00:00Z";
  await lookupWith(limited, key, now);
  await lookupWith(limited, key, now);

  expect(await lookupWith(limited, key, now)).toMatchObject({
    code: "service_daily_limit_reached",
  });
});

test.each([
  ["not a number", "many"],
  ["zero", "0"],
  ["negative", "-5"],
  ["fractional", "2.5"],
  ["empty", ""],
])(
  "a service-wide limit that is %s refuses metered requests unavailable (503), never unlimited",
  async (_, value) => {
    const { key } = await issueKey();
    const misconfigured = withKeyCeiling(asVar(value));

    expect(
      await lookupWith(misconfigured, key, "2026-11-11T12:00:00Z"),
    ).toMatchObject({ code: "auth_unavailable" });
    expect(
      await keylessLookup(
        { ...env, SERVICE_KEYLESS_DAILY_LIMIT: asVar(value) },
        "203.0.113.60",
        "2026-11-11T12:00:00Z",
      ),
    ).toMatchObject({ code: "auth_unavailable" });
  },
);

test("keyless IPv6 callers are counted per /64: addresses in one /64 share a day's quota, another /64 has its own", async () => {
  const unlimitedBursts = { ...env, KEYLESS_BURST_LIMITER: noBurstLimit };
  const now = "2026-11-12T12:00:00Z";
  const sameNetwork = [
    "2001:db8:1:2::a",
    "2001:0db8:0001:0002:0000:0000:0000:000b",
    "2001:db8:1:2:ffff:1:2:3",
  ];
  for (let i = 0; i < 5; i++) {
    expect(
      await keylessLookup(unlimitedBursts, sameNetwork[i % 3] ?? null, now),
      `request ${i + 1}`,
    ).toMatchObject({ code: "not_found" });
  }

  expect(
    await keylessLookup(unlimitedBursts, "2001:db8:1:2::c", now),
  ).toMatchObject({ code: "daily_quota_exceeded" });
  expect(
    await keylessLookup(unlimitedBursts, "2001:db8:1:3::a", now),
  ).toMatchObject({ code: "not_found" });
});

/** The `CF-Connecting-IP` Cloudflare sets on a Worker's subrequest to another Cloudflare zone. */
const CROSS_ZONE_WORKER_IP = "2a06:98c0:3600::103";

test("keyless requests from Cloudflare's cross-zone Worker address are counted apart per calling zone", async () => {
  const unlimitedBursts = { ...env, KEYLESS_BURST_LIMITER: noBurstLimit };
  const now = "2026-11-13T12:00:00Z";
  const ip = CROSS_ZONE_WORKER_IP;
  for (let i = 1; i <= 5; i++) {
    await keylessLookup(unlimitedBursts, ip, now, "zone-a.example");
  }

  expect(
    await keylessLookup(unlimitedBursts, ip, now, "zone-a.example"),
  ).toMatchObject({ code: "daily_quota_exceeded" });
  expect(
    await keylessLookup(unlimitedBursts, ip, now, "zone-b.example"),
  ).toMatchObject({ code: "not_found" });
  expect(await keylessLookup(unlimitedBursts, ip, now)).toMatchObject({
    code: "not_found",
  });
});

test("from any other IP a CF-Worker header is ignored: rotating it doesn't get a client more requests", async () => {
  const unlimitedBursts = { ...env, KEYLESS_BURST_LIMITER: noBurstLimit };
  const now = "2026-11-13T12:00:00Z";
  const ip = "203.0.113.71";
  for (let i = 1; i <= 5; i++) {
    await keylessLookup(unlimitedBursts, ip, now, `spoofed-${i}.example`);
  }

  expect(
    await keylessLookup(unlimitedBursts, ip, now, "spoofed-6.example"),
  ).toMatchObject({ code: "daily_quota_exceeded" });
});

test("past 600 requests a minute carrying a key from one client, the next is 429 before any key is looked up", async () => {
  const unknownKey = `npk_${"Q".repeat(64)}`;
  const from = (env: Env) =>
    lookup("530196605", {
      env,
      credential: unknownKey,
      clientIp: "203.0.113.90",
      cfWorker: null,
      now: new Date(),
    });
  await startOfMinuteWindow();
  for (let i = 1; i <= 600; i++) {
    const result = await from(env);
    if (result.ok || result.error.code !== "invalid_api_key") {
      throw new Error(`request ${i}: ${JSON.stringify(result)}`);
    }
  }
  const noQueries = {
    prepare: () => {
      throw new Error("D1_ERROR: the key was looked up");
    },
  } as unknown as D1Database;

  expect(await from({ ...env, APP_DB: noQueries })).toStrictEqual({
    ok: false,
    error: {
      code: "per_minute_limit_exceeded",
      message:
        "Requests with an API key from one client are limited to 600 requests per minute. Retry in 60 seconds.",
      retryAfterSeconds: 60,
    },
  });
}, 50_000);
