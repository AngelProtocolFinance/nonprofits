import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startOfMinuteWindow } from "./clock-windows.ts";
import {
  ADMIN_AUTHORIZATION,
  createWorkerHarness,
  type IssuedKey,
  issueKey,
  listenSeeded,
  postAdmin,
  testEnv,
} from "./harness.ts";

const server = createWorkerHarness();

beforeAll(async () => {
  await listenSeeded(server);
});

afterAll(async () => {
  await server.close();
});

describe("API key guard on GET /v1/orgs/:ein", () => {
  test("serves a request with no Authorization header on the keyless tier: 200 with the org", async () => {
    const response = await server.fetch("/v1/orgs/530196605", {
      headers: { "cf-connecting-ip": "203.0.113.80" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ein: "530196605",
      name: "AMERICAN NATIONAL RED CROSS",
    });
  });

  test.each([
    "Bearer not-a-key",
    `Bearer npk_${"a".repeat(63)}`,
    `Bearer npk_${"a".repeat(63)}_`,
    `Basic npk_${"a".repeat(64)}`,
    `npk_${"a".repeat(64)}`,
  ])(
    "refuses a malformed key (%s), never serving it keyless: 401 invalid_api_key naming the format",
    async (authorization) => {
      const response = await server.fetch("/v1/orgs/530196605", {
        headers: { authorization },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(
        'Bearer realm="nonprofits", error="invalid_token"',
      );
      expect(await response.json()).toMatchObject({
        code: "invalid_api_key",
        detail:
          "API key is malformed: expected `npk_` followed by 64 letters, sent as `Authorization: Bearer <key>`. Requests sent without an `Authorization` header get a small free tier; for more, ask the operator for a key.",
      });
    },
  );

  test("refuses a well-formed key nobody issued: 401 invalid_api_key", async () => {
    const response = await server.fetch("/v1/orgs/530196605", {
      headers: { authorization: `Bearer npk_${"Q".repeat(64)}` },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "invalid_api_key",
      detail:
        "API key not recognized: check it was copied whole. Requests sent without an `Authorization` header get a small free tier; for more, ask the operator for a key.",
    });
  });
});

describe("admin key endpoints", () => {
  test("issue a key that opens the lookup: 201 with the key, then 200 with the org", async () => {
    const created = await postAdmin(server, "/admin/keys", {
      email: "Owner@Example.org",
      name: "ci",
    });
    expect(created.status).toBe(201);
    const issued = (await created.json()) as IssuedKey;
    expect(issued).toStrictEqual({
      id: expect.any(String),
      key: expect.stringMatching(/^npk_[A-Za-z]{64}$/),
      name: "ci",
      ownerEmail: "owner@example.org",
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      expiresAt: null,
    });

    const response = await server.fetch("/v1/orgs/530196605", {
      headers: { authorization: `Bearer ${issued.key}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ein: "530196605",
      name: "AMERICAN NATIONAL RED CROSS",
    });
  });

  test("revoke a key: 200, then its next lookup is 401 revoked_api_key", async () => {
    const issued = await issueKey(server);
    const authorization = `Bearer ${issued.key}`;
    const before = await server.fetch("/v1/orgs/530196605", {
      headers: { authorization },
    });
    expect(before.status).toBe(200);

    const revoked = await postAdmin(server, `/admin/keys/${issued.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toStrictEqual({
      id: issued.id,
      status: "revoked",
    });

    const after = await server.fetch("/v1/orgs/530196605", {
      headers: { authorization },
    });
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toBe(
      'Bearer realm="nonprofits", error="invalid_token"',
    );
    expect(await after.json()).toMatchObject({
      code: "revoked_api_key",
      detail:
        "API key has been revoked. Requests sent without an `Authorization` header get a small free tier; for more, ask the operator for a key.",
    });
  });

  test("stores keys hashed only: the key table holds the key's row but not its secret", async () => {
    const issued = await issueKey(server);
    const { APP_DB } = await testEnv(server);
    const { results } = await APP_DB.prepare("SELECT * FROM apikey").all();
    const table = JSON.stringify(results);
    expect(table).toContain(issued.id);
    expect(table).not.toContain(issued.key);
    expect(table).not.toContain(issued.key.slice("npk_".length));
  });

  test("logs each refused key as one info line without key material, and no base-URL warning", async () => {
    const revoked = await issueKey(server);
    await postAdmin(server, `/admin/keys/${revoked.id}/revoke`);
    const unknown = `npk_${"Z".repeat(64)}`;
    const before = server.getLogs().length;

    for (const key of [unknown, revoked.key]) {
      await server.fetch("/v1/orgs/530196605", {
        headers: { authorization: `Bearer ${key}` },
      });
    }

    const refusals = server
      .getLogs()
      .slice(before)
      .map(({ level, message }) => ({ level, message }));
    expect(refusals).toStrictEqual([
      { level: "info", message: "api key refused: invalid_api_key" },
      { level: "info", message: "api key refused: revoked_api_key" },
    ]);
    expect(JSON.stringify(server.getLogs())).not.toMatch(/Base URL is not set/);
  });

  test("revoking an id that was never issued is 404 key_not_found", async () => {
    const response = await postAdmin(server, "/admin/keys/no-such-key/revoke");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "key_not_found" });
  });

  test("revoking an id that isn't valid percent-encoding is 400 invalid_request, not a bare 500", async () => {
    const response = await postAdmin(server, "/admin/keys/%E0%A4%A/revoke");
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
  });

  test.each([
    ["no admin token", {}],
    ["a wrong admin token", { authorization: "Bearer wrong-token" }],
  ])("refuse %s with 401 admin_unauthorized", async (_, headers) => {
    for (const [method, path, body] of [
      ["POST", "/admin/keys", { email: "owner@example.org" }],
      ["GET", "/admin/keys", undefined],
      ["POST", "/admin/keys/some-id/revoke", {}],
      ["PUT", "/admin/keys/some-id/limits", { daily: 500, perMinute: 60 }],
      ["DELETE", "/admin/keys/some-id/limits", undefined],
    ] as const) {
      const response = await server.fetch(path, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(await response.json()).toMatchObject({
        code: "admin_unauthorized",
        detail: "Admin endpoints need `Authorization: Bearer <ADMIN_TOKEN>`.",
      });
    }
  });

  test.each([
    ["a zero daily limit", { daily: 0, perMinute: 60 }],
    ["a negative per-minute limit", { daily: 500, perMinute: -1 }],
    ["a fractional limit", { daily: 1.5, perMinute: 60 }],
    ["a limit sent as a string", { daily: "10", perMinute: 60 }],
    ["a limit past 2^53", { daily: 2 ** 53, perMinute: 60 }],
    ["a missing per-minute limit", { daily: 500 }],
  ])(
    "setting limits with %s is 400 invalid_request, and the key stays default",
    async (_, body) => {
      const issued = await issueKey(server);

      const response = await server.fetch(`/admin/keys/${issued.id}/limits`, {
        method: "PUT",
        headers: {
          authorization: ADMIN_AUTHORIZATION,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "invalid_request",
        detail:
          "Send JSON with `daily` and `perMinute`, each a positive integer.",
      });
      const listed = (await (
        await server.fetch("/admin/keys", {
          headers: { authorization: ADMIN_AUTHORIZATION },
        })
      ).json()) as { keys: { id: string; tier: string }[] };
      expect(listed.keys.find((key) => key.id === issued.id)?.tier).toBe(
        "default",
      );
    },
  );
});

describe("quota on /v1", () => {
  test("a default key's 11th request inside a minute gets 429 per_minute_limit_exceeded with Retry-After", async () => {
    const issued = await issueKey(server);
    const headers = { authorization: `Bearer ${issued.key}` };
    await startOfMinuteWindow();
    for (let i = 1; i <= 10; i++) {
      await server.fetch("/v1/orgs/530196605", { headers });
    }

    const response = await server.fetch("/v1/orgs/530196605", { headers });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toMatchObject({
      code: "per_minute_limit_exceeded",
    });
  }, 30_000);

  test("without a key, an IP's 2nd request inside a minute gets 429 with Retry-After, and another IP is still served", async () => {
    const from = (ip: string) =>
      server.fetch("/v1/orgs/530196605", {
        headers: { "cf-connecting-ip": ip },
      });
    await startOfMinuteWindow();
    expect((await from("203.0.113.81")).status).toBe(200);

    const response = await from("203.0.113.81");

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toMatchObject({
      code: "per_minute_limit_exceeded",
    });
    expect((await from("203.0.113.82")).status).toBe(200);
  }, 30_000);

  test("without a key, requests from Cloudflare's cross-zone Worker address sent by two zones' Workers get a minute each", async () => {
    const via = (zone: string) =>
      server.fetch("/v1/orgs/530196605", {
        headers: {
          "cf-connecting-ip": "2a06:98c0:3600::103",
          "cf-worker": zone,
        },
      });
    await startOfMinuteWindow();

    expect((await via("zone-a.example")).status).toBe(200);
    expect((await via("zone-b.example")).status).toBe(200);
    expect((await via("zone-a.example")).status).toBe(429);
  }, 30_000);

  test("without a key, a client rotating its CF-Worker header shares its IP's minute: the 2nd request is 429", async () => {
    const claiming = (zone: string) =>
      server.fetch("/v1/orgs/530196605", {
        headers: { "cf-connecting-ip": "203.0.113.84", "cf-worker": zone },
      });
    await startOfMinuteWindow();

    expect((await claiming("spoofed-a.example")).status).toBe(200);
    expect((await claiming("spoofed-b.example")).status).toBe(429);
  }, 30_000);

  test("without a key, an invalid EIN or search isn't counted: the IP's one request a minute is still served after them", async () => {
    const from = (path: string) =>
      server.fetch(path, { headers: { "cf-connecting-ip": "203.0.113.86" } });
    await startOfMinuteWindow();

    expect((await from("/v1/orgs/12")).status).toBe(400);
    expect((await from("/v1/search?q=x")).status).toBe(400);
    expect((await from("/v1/search?q=red&limit=0")).status).toBe(400);

    expect((await from("/v1/orgs/530196605")).status).toBe(200);
    expect((await from("/v1/orgs/530196605")).status).toBe(429);
  }, 30_000);

  test("a key over its daily quota gets 429 problem details with Retry-After up to UTC midnight", async () => {
    const issued = await issueKey(server);
    const limits = await server.fetch(`/admin/keys/${issued.id}/limits`, {
      method: "PUT",
      headers: {
        authorization: ADMIN_AUTHORIZATION,
        "content-type": "application/json",
      },
      body: JSON.stringify({ daily: 1, perMinute: 60 }),
    });
    expect(limits.status).toBe(200);
    const headers = { authorization: `Bearer ${issued.key}` };
    expect((await server.fetch("/v1/orgs/530196605", { headers })).status).toBe(
      200,
    );

    const response = await server.fetch("/v1/search?q=red", { headers });

    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    const midnight = new Date();
    midnight.setUTCHours(24, 0, 0, 0);
    const retryAfter = Number(response.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(
      Math.ceil((midnight.getTime() - Date.now()) / 1000) + 1,
    );
    expect(await response.json()).toStrictEqual({
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      code: "daily_quota_exceeded",
      detail: `This key's daily quota of 1 request is used up. It resets at ${midnight.toISOString().replace(".000Z", "Z")} (UTC midnight).`,
    });
  });
});
