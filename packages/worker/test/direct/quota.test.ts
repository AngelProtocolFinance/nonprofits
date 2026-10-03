import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestHarness } from "wrangler";
import { lookup, search } from "../../src/handlers.ts";

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

/** The harness D1, summing `meta.rows_written` over every statement run through it. */
function measuredD1() {
  const tally = { rowsWritten: 0, unmeasured: [] as string[] };
  const measure = <T extends { meta: D1Meta }>(result: T): T => {
    tally.rowsWritten += result.meta.rows_written;
    return result;
  };
  const wrap = (statement: D1PreparedStatement, sql: string) =>
    ({
      bind: (...values: unknown[]) => wrap(statement.bind(...values), sql),
      all: async () => measure(await statement.all()),
      run: async () => measure(await statement.run()),
      // these return no meta: a call fails the measurement rather than escaping it
      first: (...args: [string?]) => {
        tally.unmeasured.push(sql);
        return statement.first(...(args as [string]));
      },
      raw: (...args: [{ columnNames: true }?]) => {
        tally.unmeasured.push(sql);
        return statement.raw(...(args as [{ columnNames: true }]));
      },
      inner: statement,
    }) as unknown as D1PreparedStatement;
  const db = {
    prepare: (sql: string) => wrap(env.DB.prepare(sql), sql),
    batch: async (statements: D1PreparedStatement[]) => {
      const results = await env.DB.batch(
        statements.map(
          (s) => (s as unknown as { inner: D1PreparedStatement }).inner,
        ),
      );
      return results.map(measure);
    },
    exec: (sql: string) => {
      tally.unmeasured.push(sql);
      return env.DB.exec(sql);
    },
  } as unknown as D1Database;
  return { db, tally };
}

// a day's worth of requests runs in one real minute: past the burst binding, which limits.test.ts covers
const noBurstLimit: RateLimit = { limit: async () => ({ success: true }) };

/** The outcome code of a lookup at `now`; this D1 holds no orgs, so an admitted one is `not_found`. */
async function lookupAt(key: string, now: string, db = env.DB) {
  const result = await lookup("530196605", {
    env: { ...env, DB: db, KEY_BURST_LIMITER: noBurstLimit },
    credential: key,
    clientIp: null,
    now: new Date(now),
  });
  return result.ok ? "ok" : result.error;
}

test("a fresh key gets 50 requests a UTC day; the 51st is 429 saying when it resets, and the next day opens again", async () => {
  const { key } = await issueKey();

  for (let i = 1; i <= 50; i++) {
    expect(
      await lookupAt(key, "2026-10-03T23:58:30Z"),
      `request ${i}`,
    ).toMatchObject({
      code: "not_found",
    });
  }
  expect(await lookupAt(key, "2026-10-03T23:58:30Z")).toStrictEqual({
    code: "daily_quota_exceeded",
    message:
      "This key's daily quota of 50 requests is used up. It resets at 2026-10-04T00:00:00Z (UTC midnight).",
    retryAfterSeconds: 90,
  });
  expect(await lookupAt(key, "2026-10-04T00:00:05Z")).toMatchObject({
    code: "not_found",
  });
}, 30_000);

test("a default-key request writes exactly two D1 rows: its usage counter and the service's", async () => {
  const { key } = await issueKey();
  const first = measuredD1();
  const later = measuredD1();

  expect(await lookupAt(key, "2026-10-05T12:00:00Z", first.db)).toMatchObject({
    code: "not_found",
  });
  expect(await lookupAt(key, "2026-10-05T12:00:01Z", later.db)).toMatchObject({
    code: "not_found",
  });

  // the day's first request inserts the counter row; later ones update it
  expect(first.tally).toStrictEqual({ rowsWritten: 2, unmeasured: [] });
  expect(later.tally).toStrictEqual({ rowsWritten: 2, unmeasured: [] });
});

test("lookup and search count against the same daily quota", async () => {
  const { key } = await issueKey();
  const now = new Date("2026-10-06T08:00:00Z");
  const searchAt = async () => {
    const result = await search(
      { query: "red cross" },
      {
        env: { ...env, KEY_BURST_LIMITER: noBurstLimit },
        credential: key,
        clientIp: null,
        now,
      },
    );
    return result.ok ? "ok" : result.error.code;
  };

  for (let i = 1; i <= 25; i++) {
    expect(await lookupAt(key, now.toISOString())).toMatchObject({
      code: "not_found",
    });
    expect(await searchAt()).toBe("ok");
  }

  expect(await searchAt()).toBe("daily_quota_exceeded");
  expect(await lookupAt(key, now.toISOString())).toMatchObject({
    code: "daily_quota_exceeded",
  });
}, 30_000);

test("a revoked key over its quota is refused as revoked (401), not as over quota", async () => {
  const { id, key } = await issueKey();
  const now = "2026-10-07T08:00:00Z";
  for (let i = 1; i <= 50; i++) await lookupAt(key, now);
  expect(await lookupAt(key, now)).toMatchObject({
    code: "daily_quota_exceeded",
  });

  await adminFetch("POST", `/admin/keys/${id}/revoke`);

  expect(await lookupAt(key, now)).toMatchObject({ code: "revoked_api_key" });
}, 30_000);

test("raising one key's limits lets it past request 51 while a default key still stops at 51", async () => {
  const raised = await issueKey();
  const untouched = await issueKey();
  const set = await adminFetch("PUT", `/admin/keys/${raised.id}/limits`, {
    daily: 500,
    perMinute: 60,
  });
  expect(set.status).toBe(200);
  expect(await set.json()).toStrictEqual({
    id: raised.id,
    tier: "whitelisted",
    daily: 500,
    perMinute: 60,
  });

  // one request a minute keeps the raised key under its per-minute limit
  const at = (i: number) => new Date(Date.UTC(2026, 9, 8, 1, i)).toISOString();
  for (let i = 1; i <= 50; i++) {
    await lookupAt(raised.key, at(i));
    await lookupAt(untouched.key, at(i));
  }

  expect(await lookupAt(raised.key, at(51))).toMatchObject({
    code: "not_found",
  });
  expect(await lookupAt(untouched.key, at(51))).toMatchObject({
    code: "daily_quota_exceeded",
  });
}, 60_000);

async function whitelistedKey(daily: number, perMinute: number) {
  const issued = await issueKey();
  await adminFetch("PUT", `/admin/keys/${issued.id}/limits`, {
    daily,
    perMinute,
  });
  return issued;
}

test("a whitelisted key's 61st request inside one minute is 429 until the next minute starts", async () => {
  const { key } = await whitelistedKey(500, 60);

  for (let i = 1; i <= 60; i++) {
    expect(
      await lookupAt(key, "2026-10-09T10:00:05Z"),
      `request ${i}`,
    ).toMatchObject({
      code: "not_found",
    });
  }
  expect(await lookupAt(key, "2026-10-09T10:00:58.500Z")).toStrictEqual({
    code: "per_minute_limit_exceeded",
    message:
      "This key's limit of 60 requests per minute is reached. Retry at 2026-10-09T10:01:00Z.",
    retryAfterSeconds: 2,
  });
  expect(await lookupAt(key, "2026-10-09T10:01:00Z")).toMatchObject({
    code: "not_found",
  });
}, 30_000);

test("a whitelisted key over its own daily quota is refused as daily, not per-minute", async () => {
  const { key } = await whitelistedKey(3, 60);
  for (let i = 1; i <= 3; i++) await lookupAt(key, "2026-10-09T11:00:00Z");

  expect(await lookupAt(key, "2026-10-09T11:00:00Z")).toMatchObject({
    code: "daily_quota_exceeded",
    message:
      "This key's daily quota of 3 requests is used up. It resets at 2026-10-10T00:00:00Z (UTC midnight).",
  });
});

test("a whitelisted request writes one D1 row, and a refused one writes none", async () => {
  const { key } = await whitelistedKey(1, 60);
  const admitted = measuredD1();
  const refused = measuredD1();

  await lookupAt(key, "2026-10-09T12:00:00Z", admitted.db);
  expect(await lookupAt(key, "2026-10-09T12:00:00Z", refused.db)).toMatchObject(
    {
      code: "daily_quota_exceeded",
    },
  );

  expect(admitted.tally).toStrictEqual({ rowsWritten: 1, unmeasured: [] });
  expect(refused.tally).toStrictEqual({ rowsWritten: 0, unmeasured: [] });
});

test("a default key's last request of the day writes both rows, and the refused one after it writes none", async () => {
  const { key } = await issueKey();
  const now = "2026-10-10T09:00:00Z";
  for (let i = 1; i <= 49; i++) await lookupAt(key, now);
  const last = measuredD1();
  const refused = measuredD1();

  expect(await lookupAt(key, now, last.db)).toMatchObject({
    code: "not_found",
  });
  expect(await lookupAt(key, now, refused.db)).toMatchObject({
    code: "daily_quota_exceeded",
  });

  expect(last.tally).toStrictEqual({ rowsWritten: 2, unmeasured: [] });
  expect(refused.tally).toStrictEqual({ rowsWritten: 0, unmeasured: [] });
}, 30_000);

test("a keyless request writes at most two D1 rows, its IP's counter and the service's, and a refused one writes none", async () => {
  const now = new Date("2026-10-11T09:00:00Z");
  const keyless = async (db: D1Database) => {
    const result = await lookup("530196605", {
      env: { ...env, DB: db, KEYLESS_BURST_LIMITER: noBurstLimit },
      credential: null,
      clientIp: "192.0.2.60",
      now,
    });
    return result.ok ? "ok" : result.error.code;
  };
  const first = measuredD1();
  const last = measuredD1();
  const refused = measuredD1();

  expect(await keyless(first.db)).toBe("not_found");
  for (let i = 2; i <= 4; i++) await keyless(env.DB);
  expect(await keyless(last.db)).toBe("not_found");
  expect(await keyless(refused.db)).toBe("daily_quota_exceeded");

  expect(first.tally).toStrictEqual({ rowsWritten: 2, unmeasured: [] });
  expect(last.tally).toStrictEqual({ rowsWritten: 2, unmeasured: [] });
  expect(refused.tally).toStrictEqual({ rowsWritten: 0, unmeasured: [] });
});
