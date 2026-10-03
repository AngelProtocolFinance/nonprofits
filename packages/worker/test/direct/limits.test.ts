import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createTestHarness } from "wrangler";
import { lookup, search } from "../../src/handlers.ts";
import { startOfBurstWindow } from "../clock-windows.ts";
import {
  virtualAt,
  virtualDay,
  virtualMidnightAfter,
} from "../virtual-clock.ts";
import { emptyServedData } from "./empty-data.ts";
import { countingLimiter, noBurstLimit } from "./limiters.ts";
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

/**
 * The Worker's env with every Rate Limiting binding admitting all calls, but
 * for `overrides`: a test about a count in D1 isn't a test of a binding's
 * minute, which `countingLimiter` doubles or the one real burst test cover.
 */
function burstless(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    KEY_BURST_LIMITER: noBurstLimit,
    KEYLESS_BURST_LIMITER: noBurstLimit,
    KEYED_REQUEST_LIMITER: noBurstLimit,
    ...overrides,
  };
}

/** The Worker's env with default-tier keys' service-wide daily limit set to `limit`. */
function withKeyCeiling(limit: number, overrides: Partial<Env> = {}): Env {
  return burstless({ SERVICE_KEY_DAILY_LIMIT: limit, ...overrides });
}

/** `key_usage` as `requests` admitted requests would leave it, without sending them. */
async function seedUsage(subject: string, day: string, requests: number) {
  await env.APP_DB.prepare(
    `INSERT INTO key_usage (subject, day, requests, minute, minute_requests)
     VALUES (?1, ?2, ?3, 0, 0)
     ON CONFLICT (subject, day) DO UPDATE SET requests = excluded.requests`,
  )
    .bind(subject, day, requests)
    .run();
}

async function usedOn(subject: string, day: string) {
  const row = await env.APP_DB.prepare(
    "SELECT requests FROM key_usage WHERE subject = ?1 AND day = ?2",
  )
    .bind(subject, day)
    .first<{ requests: number }>();
  return row?.requests;
}

/** The outcome of a lookup with `credential` at `now`; the served data DB holds no orgs, so an admitted one is `not_found`. */
async function lookupWith(env: Env, credential: string, now: string) {
  const result = await lookup("530196605", {
    env,
    credential,
    clientIp: null,
    cfWorker: null,
    now: new Date(now),
  });
  return result.ok ? "ok" : result.error;
}

async function whitelistedKey(daily: number, perMinute: number) {
  const issued = await issueKey();
  await adminFetch("PUT", `/admin/keys/${issued.id}/limits`, {
    daily,
    perMinute,
  });
  return issued;
}

test("a default key's 11th request inside a minute is 429 per_minute_limit_exceeded and uncounted; another key is still served", async () => {
  const burst = countingLimiter(10);
  const limited = burstless({ KEY_BURST_LIMITER: burst });
  const first = await issueKey();
  const second = await issueKey();
  const now = virtualAt(1);

  for (let i = 1; i <= 10; i++) {
    expect(
      await lookupWith(limited, first.key, now),
      `request ${i}`,
    ).toMatchObject({ code: "not_found" });
  }
  expect(await lookupWith(limited, first.key, now)).toStrictEqual({
    code: "per_minute_limit_exceeded",
    message:
      "This key's limit of 10 requests per minute is reached. Retry in 60 seconds.",
    retryAfterSeconds: 60,
  });

  // the binding counts per key id, and the refusal wrote no usage
  expect(burst.keys).toStrictEqual(Array(11).fill(first.id));
  expect(await usedOn(first.id, virtualDay(1))).toBe(10);
  expect(await lookupWith(limited, second.key, now)).toMatchObject({
    code: "not_found",
  });
});

test("a whitelisted key's 11th request inside a minute is served: the burst binding is the default tier's", async () => {
  const refusingAll = countingLimiter(0);
  const limited = burstless({ KEY_BURST_LIMITER: refusingAll });
  const whitelisted = await whitelistedKey(500, 60);
  const standard = await issueKey();
  const now = virtualAt(2);

  for (let i = 1; i <= 11; i++) {
    expect(
      await lookupWith(limited, whitelisted.key, now),
      `request ${i}`,
    ).toMatchObject({ code: "not_found" });
  }

  // the same binding refuses a default key, so none of the 11 calls reached it
  expect(refusingAll.keys).toStrictEqual([]);
  expect(await lookupWith(limited, standard.key, now)).toMatchObject({
    code: "per_minute_limit_exceeded",
  });
  expect(refusingAll.keys).toStrictEqual([standard.id]);
});

test("past the service-wide daily limit, the next default-tier request across two keys is 429; a whitelisted key is still served", async () => {
  const limited = withKeyCeiling(5);
  const first = await issueKey();
  const second = await issueKey();
  const whitelisted = await whitelistedKey(500, 60);
  const now = virtualAt(3);

  for (const { key } of [first, second, first, second, first]) {
    expect(await lookupWith(limited, key, now)).toMatchObject({
      code: "not_found",
    });
  }
  expect(await lookupWith(limited, second.key, now)).toStrictEqual({
    code: "service_daily_limit_reached",
    message: `The service-wide daily limit for default-tier keys is reached. It resets at ${virtualMidnightAfter(3)} (UTC midnight). Keys with their own limits from the operator are not affected.`,
    retryAfterSeconds: 43_200,
  });
  expect(await lookupWith(limited, whitelisted.key, now)).toMatchObject({
    code: "not_found",
  });
});

test("a request refused by its own daily quota does not count toward the service-wide limit", async () => {
  const limited = withKeyCeiling(52);
  const spent = await issueKey();
  const other = await issueKey();
  const day = virtualDay(4);
  const now = virtualAt(4);
  // the 50 requests a default key may send in a day (quota.test.ts sends them)
  await seedUsage(spent.id, day, 50);
  await seedUsage("*:key", day, 50);

  for (let i = 1; i <= 3; i++) {
    expect(await lookupWith(limited, spent.key, now)).toMatchObject({
      code: "daily_quota_exceeded",
    });
  }

  // 50 of 52 used: the three refusals left two for another key
  expect(await usedOn("*:key", day)).toBe(50);
  expect(await lookupWith(limited, other.key, now)).toMatchObject({
    code: "not_found",
  });
  expect(await lookupWith(limited, other.key, now)).toMatchObject({
    code: "not_found",
  });
  expect(await lookupWith(limited, other.key, now)).toMatchObject({
    code: "service_daily_limit_reached",
  });
});

test("a request refused by the service-wide limit does not count toward its key's daily quota", async () => {
  const { id, key } = await issueKey();
  const day = virtualDay(5);
  const now = virtualAt(5);
  for (let i = 1; i <= 5; i++) {
    await lookupWith(withKeyCeiling(5), key, now);
  }
  for (let i = 1; i <= 3; i++) {
    expect(await lookupWith(withKeyCeiling(5), key, now)).toMatchObject({
      code: "service_daily_limit_reached",
    });
  }
  expect(await usedOn(id, day)).toBe(5);

  // the operator raises the service limit; the key has 1 of its 50 left
  const raised = withKeyCeiling(1000);
  await seedUsage(id, day, 49);
  expect(await lookupWith(raised, key, now)).toMatchObject({
    code: "not_found",
  });
  expect(await lookupWith(raised, key, now)).toMatchObject({
    code: "daily_quota_exceeded",
  });
});

/** A keyless lookup from `clientIp` at `now`, sent by the Worker named in `cfWorker` if any. */
async function keylessLookup(
  env: Env,
  clientIp: string | null,
  now: string,
  cfWorker: string | null = null,
  ein = "530196605",
) {
  const result = await lookup(ein, {
    env,
    credential: null,
    clientIp,
    cfWorker,
    now: new Date(now),
  });
  return result.ok ? "ok" : result.error;
}

test("without a key an IP gets 5 requests a UTC day; the 6th is 429 saying a key lifts the limit, and another IP is still served", async () => {
  const unlimitedBursts = burstless();
  const now = virtualAt(6, "22:00:00");

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
    message: `Requests without an API key are limited to 5 requests a UTC day per IP address, and this address has used them. They reset at ${virtualMidnightAfter(6)} (UTC midnight). An API key lifts this limit: ask the operator for one.`,
    retryAfterSeconds: 7200,
  });
  expect(
    await keylessLookup(unlimitedBursts, "203.0.113.11", now),
  ).toMatchObject({ code: "not_found" });
});

test("without a key an IP's 2nd request inside a minute is 429 per_minute_limit_exceeded, saying a key lifts the limit; another IP is still served", async () => {
  const burst = countingLimiter(1);
  const limited = burstless({ KEYLESS_BURST_LIMITER: burst });
  const now = virtualAt(7);

  expect(await keylessLookup(limited, "203.0.113.30", now)).toMatchObject({
    code: "not_found",
  });
  expect(await keylessLookup(limited, "203.0.113.30", now)).toStrictEqual({
    code: "per_minute_limit_exceeded",
    message:
      "Requests without an API key are limited to 1 request per minute per IP address. Retry in 60 seconds. An API key lifts this limit: ask the operator for one.",
    retryAfterSeconds: 60,
  });
  expect(await keylessLookup(limited, "203.0.113.31", now)).toMatchObject({
    code: "not_found",
  });
});

test("without a key, a client rotating its CF-Worker header shares its IP's minute: the 2nd request is 429", async () => {
  const limited = burstless({ KEYLESS_BURST_LIMITER: countingLimiter(1) });
  const now = virtualAt(8);

  expect(
    await keylessLookup(limited, "203.0.113.84", now, "spoofed-a.example"),
  ).toMatchObject({ code: "not_found" });
  expect(
    await keylessLookup(limited, "203.0.113.84", now, "spoofed-b.example"),
  ).toMatchObject({ code: "per_minute_limit_exceeded" });
});

test("without a key, requests from Cloudflare's cross-zone Worker address sent by two zones' Workers get a minute each", async () => {
  const limited = burstless({ KEYLESS_BURST_LIMITER: countingLimiter(1) });
  const now = virtualAt(8);
  const via = (zone: string) =>
    keylessLookup(limited, CROSS_ZONE_WORKER_IP, now, zone);

  expect(await via("zone-a.example")).toMatchObject({ code: "not_found" });
  expect(await via("zone-b.example")).toMatchObject({ code: "not_found" });
  expect(await via("zone-a.example")).toMatchObject({
    code: "per_minute_limit_exceeded",
  });
});

test("without a key, an invalid EIN or search isn't counted: the IP's one request a minute is still served after them", async () => {
  const burst = countingLimiter(1);
  const limited = burstless({ KEYLESS_BURST_LIMITER: burst });
  const now = virtualAt(9);
  const ip = "203.0.113.86";
  const keylessSearch = async (input: { query: string; limit?: number }) => {
    const result = await search(input, {
      env: limited,
      credential: null,
      clientIp: ip,
      cfWorker: null,
      now: new Date(now),
    });
    return result.ok ? "ok" : result.error.code;
  };

  expect(await keylessLookup(limited, ip, now, null, "12")).toMatchObject({
    code: "invalid_ein",
  });
  expect(await keylessSearch({ query: "x" })).toBe("invalid_query");
  expect(await keylessSearch({ query: "red", limit: 0 })).toBe("invalid_limit");
  expect(burst.keys).toStrictEqual([]);

  expect(await keylessLookup(limited, ip, now)).toMatchObject({
    code: "not_found",
  });
  expect(await keylessLookup(limited, ip, now)).toMatchObject({
    code: "per_minute_limit_exceeded",
  });
  expect(burst.keys).toHaveLength(2);
});

test("without a key, search and lookup count against the same per-IP daily quota", async () => {
  const unlimitedBursts = burstless();
  const now = virtualAt(10, "08:00:00");
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
  const limited = burstless({ SERVICE_KEYLESS_DAILY_LIMIT: 2 });
  const { key } = await issueKey();
  const now = virtualAt(11);
  await keylessLookup(limited, "203.0.113.50", now);
  await keylessLookup(limited, "203.0.113.51", now);

  expect(await keylessLookup(limited, "203.0.113.52", now)).toStrictEqual({
    code: "service_daily_limit_reached",
    message: `The service-wide daily limit for requests without an API key is reached. It resets at ${virtualMidnightAfter(11)} (UTC midnight). An API key lifts this limit: ask the operator for one.`,
    retryAfterSeconds: 43_200,
  });
  expect(await lookupWith(limited, key, now)).toMatchObject({
    code: "not_found",
  });
});

test("default keys at their service-wide daily limit are 429 while keyless traffic is still served", async () => {
  const limited = withKeyCeiling(2);
  const { key } = await issueKey();
  const now = virtualAt(12);
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
  const day = virtualDay(13);
  await keylessLookup(burstless(), ip, `${day}T12:00:00Z`);

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
  const unlimitedBursts = burstless();
  const now = virtualAt(14);
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
  const limited = withKeyCeiling(asVar("2"));
  const { key } = await issueKey();
  const now = virtualAt(15);
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
    const now = virtualAt(16);

    expect(await lookupWith(misconfigured, key, now)).toMatchObject({
      code: "auth_unavailable",
    });
    expect(
      await keylessLookup(
        burstless({ SERVICE_KEYLESS_DAILY_LIMIT: asVar(value) }),
        "203.0.113.60",
        now,
      ),
    ).toMatchObject({ code: "auth_unavailable" });
  },
);

test("keyless IPv6 callers are counted per /64: addresses in one /64 share a day's quota, another /64 has its own", async () => {
  const unlimitedBursts = burstless();
  const now = virtualAt(17);
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

test("an IPv4-mapped IPv6 caller shares the quota of the IPv4 client it maps; another IPv4 client has its own", async () => {
  const unlimitedBursts = burstless();
  const now = virtualAt(18);
  const callers = [
    "192.0.2.1",
    "::ffff:192.0.2.1",
    "192.0.2.1",
    "::ffff:192.0.2.1",
    "192.0.2.1",
  ];
  for (const [i, ip] of callers.entries()) {
    expect(
      await keylessLookup(unlimitedBursts, ip, now),
      `request ${i + 1}`,
    ).toMatchObject({ code: "not_found" });
  }

  expect(
    await keylessLookup(unlimitedBursts, "::ffff:192.0.2.1", now),
  ).toMatchObject({ code: "daily_quota_exceeded" });
  expect(await keylessLookup(unlimitedBursts, "192.0.2.1", now)).toMatchObject({
    code: "daily_quota_exceeded",
  });
  expect(
    await keylessLookup(unlimitedBursts, "::ffff:192.0.2.2", now),
  ).toMatchObject({ code: "not_found" });
});

/** The `CF-Connecting-IP` Cloudflare sets on a Worker's subrequest to another Cloudflare zone. */
const CROSS_ZONE_WORKER_IP = "2a06:98c0:3600::103";

test("keyless requests from Cloudflare's cross-zone Worker address are counted apart per calling zone", async () => {
  const unlimitedBursts = burstless();
  const now = virtualAt(19);
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
  const unlimitedBursts = burstless();
  const now = virtualAt(20);
  const ip = "203.0.113.71";
  for (let i = 1; i <= 5; i++) {
    await keylessLookup(unlimitedBursts, ip, now, `spoofed-${i}.example`);
  }

  expect(
    await keylessLookup(unlimitedBursts, ip, now, "spoofed-6.example"),
  ).toMatchObject({ code: "daily_quota_exceeded" });
});

const UNKNOWN_KEY = `npk_${"Q".repeat(64)}`;

/** A lookup carrying a well-formed key nobody issued, from `clientIp`. */
function withUnknownKey(env: Env, clientIp: string) {
  return lookup("530196605", {
    env,
    credential: UNKNOWN_KEY,
    clientIp,
    cfWorker: null,
    now: new Date(),
  });
}

/** An `APP_DB` that knows no key, answering at once: a burst of 600 would take seconds against D1. */
const NO_SUCH_KEY = {
  prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }),
} as unknown as D1Database;

/** An `APP_DB` that fails the key lookup it is asked for. */
const KEY_LOOKUP_FORBIDDEN = {
  prepare: () => {
    throw new Error("D1_ERROR: the key was looked up");
  },
} as unknown as D1Database;

test("past a client's limit on requests carrying a key, the next is 429 before any key is looked up", async () => {
  const burst = countingLimiter(3);
  const limited = { ...env, KEYED_REQUEST_LIMITER: burst };
  for (let i = 1; i <= 3; i++) {
    expect(await withUnknownKey(limited, "203.0.113.91")).toMatchObject({
      error: { code: "invalid_api_key" },
    });
  }

  const refused = await withUnknownKey(
    { ...limited, APP_DB: KEY_LOOKUP_FORBIDDEN },
    "203.0.113.91",
  );

  expect(refused).toStrictEqual({
    ok: false,
    error: {
      code: "per_minute_limit_exceeded",
      message:
        "Requests with an API key from one client are limited to 600 requests per minute. Retry in 60 seconds.",
      retryAfterSeconds: 60,
    },
  });
  // counted per client, not per key
  expect(new Set(burst.keys).size).toBe(1);
});

test("past 600 requests a minute carrying a key from one client, the next is 429 before any key is looked up", async () => {
  const client = "203.0.113.90";
  const noKeys = { ...env, APP_DB: NO_SUCH_KEY };
  // each refused key logs a line: 600 of them would bury a failure's output
  const refusals = vi.spyOn(console, "info").mockImplementation(() => {});
  // the one test of the real binding: its minute, so a burst that wouldn't fit waits for the next
  await startOfBurstWindow(601, () => withUnknownKey(noKeys, "203.0.113.89"));
  for (let i = 1; i <= 600; i++) {
    const result = await withUnknownKey(noKeys, client);
    if (result.ok || result.error.code !== "invalid_api_key") {
      throw new Error(`request ${i}: ${JSON.stringify(result)}`);
    }
  }

  const refused = await withUnknownKey(
    { ...env, APP_DB: KEY_LOOKUP_FORBIDDEN },
    client,
  );
  refusals.mockRestore();

  expect(refused).toStrictEqual({
    ok: false,
    error: {
      code: "per_minute_limit_exceeded",
      message:
        "Requests with an API key from one client are limited to 600 requests per minute. Retry in 60 seconds.",
      retryAfterSeconds: 60,
    },
  });
});
