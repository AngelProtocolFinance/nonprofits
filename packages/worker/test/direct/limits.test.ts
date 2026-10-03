import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestHarness } from "wrangler";
import { lookup, search } from "../../src/handlers.ts";
import { startOfMinuteWindow } from "../minute-window.ts";

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
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
  env = (await server.getWorker().getEnv()) as Env;
});

afterAll(async () => {
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

/** The outcome of a lookup with `credential`; this D1 holds no orgs, so an admitted one is `not_found`. */
async function lookupWith(
  env: Env,
  credential: string,
  now = new Date().toISOString(),
) {
  const result = await lookup("530196605", {
    env,
    credential,
    clientIp: null,
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

// a day's worth of requests from one caller runs in one real minute: past the burst binding
const noBurstLimit: RateLimit = { limit: async () => ({ success: true }) };

/** The Worker's env with the service-wide daily limit set to `limit`. */
function withServiceLimit(limit: number, overrides: Partial<Env> = {}): Env {
  return { ...env, SERVICE_DAILY_LIMIT: limit, ...overrides };
}

test("past the service-wide daily limit, the next default-tier request across two keys is 429; a whitelisted key is still served", async () => {
  const limited = withServiceLimit(5);
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
      "The service-wide daily limit for default-tier keys and requests without a key is reached. It resets at 2026-11-02T00:00:00Z (UTC midnight). Keys with their own limits from the operator are not affected.",
    retryAfterSeconds: 43_200,
  });
  expect(await lookupWith(limited, whitelisted.key, now)).toMatchObject({
    code: "not_found",
  });
});

test("a request refused by its own daily quota does not count toward the service-wide limit", async () => {
  const limited = withServiceLimit(52, { KEY_BURST_LIMITER: noBurstLimit });
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
    await lookupWith(withServiceLimit(5, unlimitedBursts), key, now);
  }
  for (let i = 1; i <= 3; i++) {
    expect(
      await lookupWith(withServiceLimit(5, unlimitedBursts), key, now),
    ).toMatchObject({ code: "service_daily_limit_reached" });
  }

  // the operator raises the service limit: the key still has 45 of its 50
  const raised = withServiceLimit(1000, unlimitedBursts);
  for (let i = 1; i <= 45; i++) {
    expect(await lookupWith(raised, key, now), `request ${i}`).toMatchObject({
      code: "not_found",
    });
  }
  expect(await lookupWith(raised, key, now)).toMatchObject({
    code: "daily_quota_exceeded",
  });
}, 30_000);

/** A keyless lookup from `clientIp` at `now`. */
async function keylessLookup(env: Env, clientIp: string | null, now: string) {
  const result = await lookup("530196605", {
    env,
    credential: null,
    clientIp,
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

test("keyless and default-key requests share the service-wide daily limit", async () => {
  const limited = withServiceLimit(3, {
    KEY_BURST_LIMITER: noBurstLimit,
    KEYLESS_BURST_LIMITER: noBurstLimit,
  });
  const { key } = await issueKey();
  const now = "2026-11-06T12:00:00Z";
  await keylessLookup(limited, "203.0.113.50", now);
  await lookupWith(limited, key, now);
  await keylessLookup(limited, "203.0.113.51", now);

  expect(await keylessLookup(limited, "203.0.113.52", now)).toMatchObject({
    code: "service_daily_limit_reached",
    retryAfterSeconds: 43_200,
  });
  expect(await lookupWith(limited, key, now)).toMatchObject({
    code: "service_daily_limit_reached",
  });
});

test("a keyless request is counted under a keyed hash of its IP; no usage row holds the IP itself", async () => {
  const ip = "198.51.100.77";
  const day = "2026-11-07";
  await keylessLookup(env, ip, `${day}T12:00:00Z`);

  const { results } = await env.DB.prepare(
    "SELECT * FROM key_usage WHERE day = ?1 AND subject LIKE 'ip:%'",
  )
    .bind(day)
    .all<{ subject: string; requests: number }>();
  expect(results).toMatchObject([
    { subject: expect.stringMatching(/^ip:[0-9a-f]{64}$/), requests: 1 },
  ]);
  const everyRow = await env.DB.prepare("SELECT * FROM key_usage").all();
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
