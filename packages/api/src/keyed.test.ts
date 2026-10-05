import { afterEach, describe, expect, test, vi } from "vitest";
import { ROWS_WRITTEN } from "./quota.ts";
import {
  failingDb,
  freshClient,
  insertKey,
  rowsWrittenBy,
  seedUsage,
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
  await api.dispose();
});

const CHALLENGE = 'Bearer realm="nonprofits", error="invalid_token"';
const FREE_TIER =
  "Requests sent without an `Authorization` header get a small free tier; for more, ask the operator for a key.";

function lookupWith(authorization: string) {
  return api.app.request("/v1/orgs/530196605", {
    headers: { ...freshClient(), authorization },
  });
}

describe("a request with a key", () => {
  test.each([
    "",
    "Bearer not-a-key",
    `Bearer npk_${"a".repeat(63)}`,
    `Bearer npk_${"a".repeat(63)}_`,
    `Basic npk_${"a".repeat(64)}`,
    `npk_${"a".repeat(64)}`,
  ])(
    "refuses a malformed key (%j), never serving it keyless: 401 invalid_api_key naming the format, with the challenge",
    async (authorization) => {
      await start();

      const response = await lookupWith(authorization);

      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toBe(
        "application/problem+json",
      );
      expect(response.headers.get("www-authenticate")).toBe(CHALLENGE);
      expect(await response.json()).toStrictEqual({
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        code: "invalid_api_key",
        detail: `API key is malformed: expected \`npk_\` followed by 64 letters, sent as \`Authorization: Bearer <key>\`. ${FREE_TIER}`,
      });
      expect(await usageRows(api)).toBe(0);
    },
  );

  test("serves a key the store holds: 200 with the org", async () => {
    await start();
    const { key } = await insertKey(api);

    const response = await lookupWith(`Bearer ${key}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ein: "530196605" });
  });

  test("authorizes a key stored as the plugin hashes it today: SHA-256, base64url, unpadded", async () => {
    // pinned: a plugin bump that hashes differently orphans every issued key, and goes red here
    await start();
    await api.appDb.client.execute({
      sql: `INSERT INTO apikey (id, configId, referenceId, key, enabled, rateLimitEnabled, requestCount, createdAt, updatedAt)
            VALUES ('pinned-key', 'default', 'pinned-owner', ?1, 1, 0, 0, ?2, ?2)`,
      args: [
        "Ac25xHNwCrIyozxh2F9Hp0KRq9B64pbTHVjOfwPoKIs",
        "2026-10-05T00:00:00Z",
      ],
    });

    const response = await lookupWith(
      `Bearer npk_${"PinnedTestVector".repeat(4)}`,
    );

    expect(response.status).toBe(200);
  });

  test("refuses a well-formed key nobody issued: 401 invalid_api_key, uncounted", async () => {
    await start();

    const response = await lookupWith(`Bearer npk_${"Q".repeat(64)}`);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(await response.json()).toMatchObject({
      code: "invalid_api_key",
      detail: `API key not recognized: check it was copied whole. ${FREE_TIER}`,
    });
    expect(await usageRows(api)).toBe(0);
  });

  test("refuses a revoked key: 401 revoked_api_key, uncounted", async () => {
    await start();
    const { key } = await insertKey(api, { enabled: 0 });

    const response = await lookupWith(`Bearer ${key}`);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(await response.json()).toMatchObject({
      code: "revoked_api_key",
      detail: `API key has been revoked. ${FREE_TIER}`,
    });
    expect(await usageRows(api)).toBe(0);
  });

  test("refuses a key past its expiresAt as invalid, and serves one a second short of it", async () => {
    await start();
    const expired = await insertKey(api, {
      expiresAt: "2026-10-05T11:59:59.000Z",
    });
    const live = await insertKey(api, {
      expiresAt: "2026-10-05T12:00:01.000Z",
    });

    const response = await lookupWith(`Bearer ${expired.key}`);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(await response.json()).toMatchObject({
      code: "invalid_api_key",
      detail: `API key has expired. ${FREE_TIER}`,
    });
    expect((await lookupWith(`Bearer ${live.key}`)).status).toBe(200);
  });

  test.each([
    ["a usage allowance", "remaining = 5", ["remaining"]],
    [
      "a refill schedule",
      "refillAmount = 10, refillInterval = 60000",
      ["refillAmount", "refillInterval"],
    ],
    [
      "the plugin's own rate limit on",
      "rateLimitEnabled = 1",
      ["rateLimitEnabled"],
    ],
    ["permissions", `permissions = '{"orgs":["read"]}'`, ["permissions"]],
    ["another plugin configuration", "configId = 'other'", ["configId"]],
  ])(
    "refuses a key row carrying %s, which this guard doesn't enforce, as invalid, and logs it by key id",
    async (_, assignment, fields) => {
      await start();
      const { id, key } = await insertKey(api);
      await api.appDb.client.execute({
        sql: `UPDATE apikey SET ${assignment} WHERE id = ?1`,
        args: [id],
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      const response = await lookupWith(`Bearer ${key}`);

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        code: "invalid_api_key",
        detail: `API key can't be used here: ask the operator for a new one. ${FREE_TIER}`,
      });
      expect(
        errors.mock.calls.map(([line]) => JSON.parse(String(line))),
      ).toStrictEqual([
        { event: "api_key_unsupported_fields", keyId: id, fields },
      ]);
    },
  );

  test.each([
    ["the key store can't be read", /./],
    ["its usage can't be counted", /insert into key_usage/i],
  ])(
    "while %s, a request with a key is a 503 auth_unavailable problem, never a 401: no challenge, no Retry-After, its cause logged",
    async (_, failing) => {
      await start({ appDbAs: (db) => failingDb(db, failing) });
      const { key } = await insertKey(api);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      const response = await lookupWith(`Bearer ${key}`);

      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toBe(
        "application/problem+json",
      );
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(response.headers.get("retry-after")).toBeNull();
      expect(await response.json()).toStrictEqual({
        type: "about:blank",
        title: "Service Unavailable",
        status: 503,
        code: "auth_unavailable",
        detail:
          "The key check is unavailable right now, so this refusal says nothing about your key. Retry shortly.",
      });
      expect(
        errors.mock.calls.map(([line]) => JSON.parse(String(line))),
      ).toEqual([expect.objectContaining({ event: "auth_unavailable" })]);
    },
  );

  test("with IP_HASH_SECRET unset, a request with a key is refused unavailable too: its client can't be capped", async () => {
    await start({ vars: { IP_HASH_SECRET: undefined } });
    const { key } = await insertKey(api);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await lookupWith(`Bearer ${key}`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "auth_unavailable" });
    expect(await usageRows(api)).toBe(0);
  });
});

const SECOND_MS = 1000;

/** The requests `key_usage` counts for `subject` on the test clock's first day. */
async function countedToday(subject: string): Promise<number> {
  const rows = await api.appDb.client.execute({
    sql: "SELECT requests FROM key_usage WHERE subject = ?1 AND day = '2026-10-05'",
    args: [subject],
  });
  return Number(rows.rows[0]?.requests ?? 0);
}

function searchWith(authorization: string) {
  return api.app.request("/v1/search?q=red%20cross", {
    headers: { ...freshClient(), authorization },
  });
}

describe("a default key's quota", () => {
  test("requests 1–50 in a UTC day are 200; the 51st is 429 saying when it resets, and the next day opens again", async () => {
    await start();
    const { key } = await insertKey(api);
    api.clock.set("2026-10-05T23:50:00Z");
    for (let i = 1; i <= 50; i++) {
      // 6 s apart: 10 a minute, inside the key's per-minute limit
      expect((await lookupWith(`Bearer ${key}`)).status, `request ${i}`).toBe(
        200,
      );
      api.clock.advance(6 * SECOND_MS);
    }

    const response = await lookupWith(`Bearer ${key}`);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("300");
    expect(await response.json()).toMatchObject({
      code: "daily_quota_exceeded",
      detail:
        "This key's daily quota of 50 requests is used up. It resets at 2026-10-06T00:00:00Z (UTC midnight).",
    });
    api.clock.set("2026-10-06T00:00:05Z");
    expect((await lookupWith(`Bearer ${key}`)).status).toBe(200);
  });

  test("lookup and search draw on the same daily count", async () => {
    await start();
    const { id, key } = await insertKey(api);
    await seedUsage(api, id, "2026-10-05", 48);

    expect((await lookupWith(`Bearer ${key}`)).status).toBe(200);
    expect((await searchWith(`Bearer ${key}`)).status).toBe(200);

    const search = await searchWith(`Bearer ${key}`);
    expect(search.status).toBe(429);
    expect(await search.json()).toMatchObject({ code: "daily_quota_exceeded" });
    const lookup = await lookupWith(`Bearer ${key}`);
    expect(await lookup.json()).toMatchObject({ code: "daily_quota_exceeded" });
  });

  test("its 11th request inside a minute is 429 from the per-minute limiter, uncounted; the next minute serves it", async () => {
    await start();
    const { id, key } = await insertKey(api);
    api.clock.set("2026-10-05T12:00:00Z");
    for (let i = 1; i <= 10; i++) {
      expect((await lookupWith(`Bearer ${key}`)).status, `request ${i}`).toBe(
        200,
      );
    }

    const eleventh = await lookupWith(`Bearer ${key}`);

    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get("retry-after")).toBe("60");
    expect(await eleventh.json()).toMatchObject({
      code: "per_minute_limit_exceeded",
      detail:
        "This key's limit of 10 requests per minute is reached. Retry in 60 seconds.",
    });
    expect(await countedToday(id)).toBe(10);
    api.clock.set("2026-10-05T12:01:00Z");
    expect((await lookupWith(`Bearer ${key}`)).status).toBe(200);
  });

  test("a revoked key over its quota is refused as revoked (401), not as over quota", async () => {
    await start();
    const { id, key } = await insertKey(api);
    await seedUsage(api, id, "2026-10-05", 50);
    expect((await lookupWith(`Bearer ${key}`)).status).toBe(429);

    await api.appDb.client.execute({
      sql: "UPDATE apikey SET enabled = 0 WHERE id = ?1",
      args: [id],
    });

    const response = await lookupWith(`Bearer ${key}`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "revoked_api_key" });
  });
});

describe("a whitelisted key's own limits", () => {
  test("a key at 500/day and 60/min passes request 51 while a default key still gets 429 at 51", async () => {
    await start();
    const raised = await insertKey(api, {
      limits: { daily: 500, perMinute: 60 },
    });
    const untouched = await insertKey(api);
    await seedUsage(api, raised.id, "2026-10-05", 50);
    await seedUsage(api, untouched.id, "2026-10-05", 50);

    expect((await lookupWith(`Bearer ${raised.key}`)).status).toBe(200);
    const refused = await lookupWith(`Bearer ${untouched.key}`);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({
      code: "daily_quota_exceeded",
    });
  });

  test("its 61st request inside one minute is 429 per_minute_limit_exceeded until the next minute starts", async () => {
    await start();
    const { key } = await insertKey(api, {
      limits: { daily: 500, perMinute: 60 },
    });
    api.clock.set("2026-10-05T10:00:05Z");
    for (let i = 1; i <= 60; i++) {
      expect((await lookupWith(`Bearer ${key}`)).status, `request ${i}`).toBe(
        200,
      );
    }
    api.clock.set("2026-10-05T10:00:58.500Z");

    const sixtyFirst = await lookupWith(`Bearer ${key}`);

    expect(sixtyFirst.status).toBe(429);
    expect(sixtyFirst.headers.get("retry-after")).toBe("2");
    expect(await sixtyFirst.json()).toMatchObject({
      code: "per_minute_limit_exceeded",
      detail:
        "This key's limit of 60 requests per minute is reached. Retry at 2026-10-05T10:01:00Z.",
    });
    api.clock.set("2026-10-05T10:01:00Z");
    expect((await lookupWith(`Bearer ${key}`)).status).toBe(200);
  });

  test("over its own daily quota it is refused as daily, not per-minute", async () => {
    await start();
    const { key } = await insertKey(api, {
      limits: { daily: 3, perMinute: 60 },
    });
    for (let i = 1; i <= 3; i++) await lookupWith(`Bearer ${key}`);

    const fourth = await lookupWith(`Bearer ${key}`);

    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toMatchObject({
      code: "daily_quota_exceeded",
      detail:
        "This key's daily quota of 3 requests is used up. It resets at 2026-10-06T00:00:00Z (UTC midnight).",
    });
  });
});

describe("the default-tier service ceiling", () => {
  test("once reached, a default key's request is 429 service_daily_limit_reached while a whitelisted key is still served", async () => {
    await start({ vars: { SERVICE_KEY_DAILY_LIMIT: "2" } });
    const first = await insertKey(api);
    const second = await insertKey(api);
    const third = await insertKey(api);
    const whitelisted = await insertKey(api, {
      limits: { daily: 500, perMinute: 60 },
    });
    await lookupWith(`Bearer ${first.key}`);
    await lookupWith(`Bearer ${second.key}`);

    const refused = await lookupWith(`Bearer ${third.key}`);

    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("43200");
    expect(await refused.json()).toMatchObject({
      code: "service_daily_limit_reached",
      detail:
        "The service-wide daily limit for default-tier keys is reached. It resets at 2026-10-06T00:00:00Z (UTC midnight). Keys with their own limits from the operator are not affected.",
    });
    expect((await lookupWith(`Bearer ${whitelisted.key}`)).status).toBe(200);
  });

  test("keyless requests don't draw on it, nor keys on the keyless one", async () => {
    await start({
      vars: { SERVICE_KEY_DAILY_LIMIT: "1", SERVICE_KEYLESS_DAILY_LIMIT: "1" },
    });
    const { key } = await insertKey(api);

    expect((await lookupWith(`Bearer ${key}`)).status).toBe(200);
    const keyless = await api.app.request("/v1/orgs/530196605", {
      headers: freshClient(),
    });
    expect(keyless.status).toBe(200);
  });

  test("with SERVICE_KEY_DAILY_LIMIT unset, the default ceiling applies: its last request is served and the next is 429", async () => {
    await start({ vars: { SERVICE_KEY_DAILY_LIMIT: undefined } });
    await seedUsage(api, "*:key", "2026-10-05", 1899);
    const first = await insertKey(api);
    const second = await insertKey(api);

    expect((await lookupWith(`Bearer ${first.key}`)).status).toBe(200);
    const next = await lookupWith(`Bearer ${second.key}`);
    expect(next.status).toBe(429);
    expect(await next.json()).toMatchObject({
      code: "service_daily_limit_reached",
    });
  });

  test.each([
    ["not a number", "many"],
    ["zero", "0"],
    ["fractional", "2.5"],
    ["empty", ""],
  ])(
    "a SERVICE_KEY_DAILY_LIMIT that is %s refuses default-key requests unavailable (503), never unlimited",
    async (_, value) => {
      await start({ vars: { SERVICE_KEY_DAILY_LIMIT: value } });
      const { key } = await insertKey(api);
      vi.spyOn(console, "error").mockImplementation(() => {});

      const response = await lookupWith(`Bearer ${key}`);

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "auth_unavailable",
        detail:
          "The key check is unavailable right now, so this refusal says nothing about your key. Retry shortly.",
      });
      expect(await usageRows(api)).toBe(0);
    },
  );
});

describe("rows written per request, which the ceilings' arithmetic uses", () => {
  test("a default key's admitted request writes 2 rows, the day's first and a later one alike; a refused one writes none", async () => {
    await start();
    const { id, key } = await insertKey(api);
    const lookup = () => lookupWith(`Bearer ${key}`);

    expect(await rowsWrittenBy(api, lookup)).toBe(ROWS_WRITTEN.metered);
    expect(await rowsWrittenBy(api, lookup)).toBe(ROWS_WRITTEN.metered);
    expect(ROWS_WRITTEN.metered).toBe(2);
    await seedUsage(api, id, "2026-10-05", 50);
    expect(await rowsWrittenBy(api, lookup)).toBe(ROWS_WRITTEN.refused);
    expect(ROWS_WRITTEN.refused).toBe(0);
  });

  test("a default key's last request of the day writes both rows, and the refused one after it writes none", async () => {
    await start();
    const { id, key } = await insertKey(api);
    await seedUsage(api, id, "2026-10-05", 49);
    const lookup = () => lookupWith(`Bearer ${key}`);

    expect(await rowsWrittenBy(api, lookup)).toBe(ROWS_WRITTEN.metered);
    expect(await rowsWrittenBy(api, lookup)).toBe(ROWS_WRITTEN.refused);
  });

  test("a default key's request refused by its per-minute limiter writes none", async () => {
    await start();
    const { key } = await insertKey(api);
    for (let i = 1; i <= 10; i++) await lookupWith(`Bearer ${key}`);

    expect(await rowsWrittenBy(api, () => lookupWith(`Bearer ${key}`))).toBe(
      ROWS_WRITTEN.refused,
    );
  });

  test("a whitelisted key's admitted request writes 1 row; one over its limit writes none", async () => {
    await start();
    const { key } = await insertKey(api, {
      limits: { daily: 1, perMinute: 60 },
    });
    const lookup = () => lookupWith(`Bearer ${key}`);

    expect(await rowsWrittenBy(api, lookup)).toBe(ROWS_WRITTEN.whitelisted);
    expect(ROWS_WRITTEN.whitelisted).toBe(1);
    expect(await rowsWrittenBy(api, lookup)).toBe(ROWS_WRITTEN.refused);
  });

  test("a keyless admitted request writes 2 rows; one over the IP's day writes none", async () => {
    await start();
    const client = freshClient();
    const lookup = () =>
      api.app.request("/v1/orgs/530196605", { headers: client });

    expect(await rowsWrittenBy(api, lookup)).toBe(ROWS_WRITTEN.metered);
    for (let i = 2; i <= 5; i++) {
      api.clock.advance(60 * SECOND_MS);
      await lookup();
    }
    api.clock.advance(60 * SECOND_MS);
    expect(await rowsWrittenBy(api, lookup)).toBe(ROWS_WRITTEN.refused);
  });

  test("a refused key writes none: unknown, revoked or malformed", async () => {
    await start();
    const revoked = await insertKey(api, { enabled: 0 });

    for (const authorization of [
      `Bearer npk_${"Q".repeat(64)}`,
      `Bearer ${revoked.key}`,
      "Bearer nope",
    ]) {
      expect(await rowsWrittenBy(api, () => lookupWith(authorization))).toBe(0);
    }
  });
});

describe("the per-client cap on requests carrying a key", () => {
  test("a client's 601st keyed request in a minute is 429 before its key is read, a valid key included; another client is still checked", async () => {
    await start();
    const { key } = await insertKey(api);
    const client = freshClient();
    // 600 refusals, each logged
    vi.spyOn(console, "info").mockImplementation(() => {});
    const from = (headers: Record<string, string>, authorization: string) =>
      api.app.request("/v1/orgs/530196605", {
        headers: { ...headers, authorization },
      });
    for (let i = 1; i <= 600; i++) {
      const guess = await from(client, `Bearer npk_${"Q".repeat(64)}`);
      if (guess.status !== 401) expect(guess.status, `guess ${i}`).toBe(401);
    }

    const capped = await from(client, `Bearer ${key}`);

    expect(capped.status).toBe(429);
    expect(capped.headers.get("retry-after")).toBe("60");
    expect(await capped.json()).toMatchObject({
      code: "per_minute_limit_exceeded",
      detail:
        "Requests with an API key from one client are limited to 600 requests per minute. Retry in 60 seconds.",
    });
    expect((await from(freshClient(), `Bearer ${key}`)).status).toBe(200);
  });
});
