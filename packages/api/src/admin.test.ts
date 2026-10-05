import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ADMIN_AUTHORIZATION,
  failingDb,
  freshClient,
  seedUsage,
  TEST_VARS,
  type TestApi,
  type TestApiOptions,
  testApi,
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

interface IssuedKey {
  id: string;
  key: string;
  name: string | null;
  ownerEmail: string;
  createdAt: string;
  expiresAt: string | null;
}

function admin(
  method: string,
  path: string,
  body?: unknown,
  authorization = ADMIN_AUTHORIZATION,
) {
  return api.app.request(path, {
    method,
    headers: { authorization, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function keyRows(): Promise<number> {
  const rows = await api.appDb.client.execute(
    "SELECT count(*) AS n FROM apikey",
  );
  return Number(rows.rows[0]?.n);
}

function lookupWith(key: string) {
  return api.app.request("/v1/orgs/530196605", {
    headers: { ...freshClient(), authorization: `Bearer ${key}` },
  });
}

describe("POST /admin/keys", () => {
  test("issues a key that opens the lookup: 201 with the key, then 200 with the org", async () => {
    await start();

    const created = await admin("POST", "/admin/keys", {
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
    const response = await lookupWith(issued.key);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ein: "530196605" });
  });
});

const EVERY_ROUTE = [
  ["POST", "/admin/keys", { email: "owner@example.org" }],
  ["GET", "/admin/keys", undefined],
  ["POST", "/admin/keys/some-id/revoke", {}],
  ["PUT", "/admin/keys/some-id/limits", { daily: 500, perMinute: 60 }],
  ["DELETE", "/admin/keys/some-id/limits", undefined],
] as const;

describe("the admin gate", () => {
  test.each([
    ["no admin token", ""],
    ["a wrong admin token", "Bearer wrong-token"],
    ["the token without its scheme", TEST_VARS.ADMIN_TOKEN ?? ""],
  ])(
    "refuses %s on every route: 401 admin_unauthorized with a challenge",
    async (_, authorization) => {
      await start();
      for (const [method, path, body] of EVERY_ROUTE) {
        const response = await admin(method, path, body, authorization);
        expect(response.status, `${method} ${path}`).toBe(401);
        expect(response.headers.get("www-authenticate")).toBe(
          'Bearer realm="nonprofits-admin"',
        );
        expect(await response.json()).toMatchObject({
          code: "admin_unauthorized",
          detail: "Admin endpoints need `Authorization: Bearer <ADMIN_TOKEN>`.",
        });
      }
    },
  );

  test.each([
    ["ADMIN_TOKEN", "unset", undefined],
    ["ADMIN_TOKEN", "shorter than 32 characters", "too-short"],
    ["ADMIN_TOKEN", "a placeholder", "replace-with-32-plus-random-characters"],
    ["BETTER_AUTH_SECRET", "unset", undefined],
  ] as const)(
    "with %s %s, stays shut even to that token: 503 admin_disabled naming it",
    async (name, _, value) => {
      await start({ vars: { [name]: value } });
      const sent =
        name === "ADMIN_TOKEN" ? `Bearer ${value}` : ADMIN_AUTHORIZATION;

      for (const [method, path, body] of EVERY_ROUTE) {
        const response = await admin(method, path, body, sent);
        expect(response.status, `${method} ${path}`).toBe(503);
        expect(await response.json()).toMatchObject({
          code: "admin_disabled",
          detail: `Admin endpoints are off: set the ${name} secret to at least 32 random characters.`,
        });
      }
      expect(await keyRows()).toBe(0);
    },
  );
});

async function issue(email = "owner@example.org"): Promise<IssuedKey> {
  const response = await admin("POST", "/admin/keys", { email });
  expect(response.status).toBe(201);
  return (await response.json()) as IssuedKey;
}

describe("logs", () => {
  test("an admin call logs no warning that the base URL is unset: the origin is derived per request on purpose", async () => {
    await start();
    const logged = (["debug", "info", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level),
    );

    await issue();

    expect(JSON.stringify(logged.map((spy) => spy.mock.calls))).not.toMatch(
      /Base URL is not set/,
    );
  });
});

describe("storage", () => {
  test("a store that fails mid-issue is a 500 problem, logged, and no key is printed", async () => {
    await start({ appDbAs: (db) => failingDb(db, /^insert into "apikey"/i) });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await admin("POST", "/admin/keys", {
      email: "owner@example.org",
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({ code: "internal_error" });
    expect(JSON.stringify(logged.mock.calls)).toContain(
      "app database unreachable",
    );
  });

  test("stores the key hashed: its apikey row holds neither the issued key nor its letters", async () => {
    await start();
    const issued = await issue();

    const { rows } = await api.appDb.client.execute({
      sql: "SELECT * FROM apikey WHERE id = ?1",
      args: [issued.id],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).not.toBe(issued.key);
    const row = JSON.stringify(rows[0]);
    expect(row).not.toContain(issued.key);
    expect(row).not.toContain(issued.key.slice("npk_".length));
  });
});

describe("POST /admin/keys/:id/revoke", () => {
  test("revokes the key: 200, then its next lookup is 401 revoked_api_key", async () => {
    await start();
    const issued = await issue();
    expect((await lookupWith(issued.key)).status).toBe(200);

    const revoked = await admin("POST", `/admin/keys/${issued.id}/revoke`, {});

    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toStrictEqual({
      id: issued.id,
      status: "revoked",
    });
    const after = await lookupWith(issued.key);
    expect(after.status).toBe(401);
    expect(await after.json()).toMatchObject({ code: "revoked_api_key" });
  });

  test("an id that was never issued is 404 key_not_found", async () => {
    await start();

    const response = await admin("POST", "/admin/keys/no-such-key/revoke", {});

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "key_not_found",
      detail: "No key with id no-such-key.",
    });
  });

  test("an id that isn't valid percent-encoding names no key: 404 key_not_found, not a bare 500", async () => {
    await start();

    const response = await admin("POST", "/admin/keys/%E0%A4%A/revoke", {});

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({ code: "key_not_found" });
  });

  test("the next admin call still answers while the revoke's expired-key sweep may be running", async () => {
    await start();
    const issued = await issue();
    await admin("POST", `/admin/keys/${issued.id}/revoke`, {});

    const created = await admin("POST", "/admin/keys", {
      email: "owner@example.org",
    });

    expect(created.status).toBe(201);
  });
});

const TODAY = "2026-10-05";

function limits(keyId: string, body: unknown) {
  return admin("PUT", `/admin/keys/${keyId}/limits`, body);
}

describe("PUT and DELETE /admin/keys/:id/limits", () => {
  test("PUT whitelists the key with its own limits: it passes request 51", async () => {
    await start();
    const issued = await issue();

    const response = await limits(issued.id, { daily: 500, perMinute: 60 });

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({
      id: issued.id,
      tier: "whitelisted",
      daily: 500,
      perMinute: 60,
    });
    await seedUsage(api, issued.id, TODAY, 50);
    expect((await lookupWith(issued.key)).status).toBe(200);
  });

  test("DELETE returns the key to the default 50 a day: request 51 is 429", async () => {
    await start();
    const issued = await issue();
    await limits(issued.id, { daily: 500, perMinute: 60 });

    const response = await admin("DELETE", `/admin/keys/${issued.id}/limits`);

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({
      id: issued.id,
      tier: "default",
      daily: 50,
      perMinute: 10,
    });
    await seedUsage(api, issued.id, TODAY, 50);
    const refused = await lookupWith(issued.key);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({
      code: "daily_quota_exceeded",
    });
  });

  test.each([
    ["a zero daily limit", { daily: 0, perMinute: 60 }],
    ["a negative per-minute limit", { daily: 500, perMinute: -1 }],
    ["a fractional limit", { daily: 1.5, perMinute: 60 }],
    ["a limit sent as a string", { daily: "10", perMinute: 60 }],
    ["a limit past 2^53", { daily: 2 ** 53, perMinute: 60 }],
    ["a missing per-minute limit", { daily: 500 }],
  ])(
    "PUT with %s is 400 invalid_request, and the key stays default",
    async (_, body) => {
      await start();
      const issued = await issue();

      const response = await limits(issued.id, body);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "invalid_request",
        detail:
          "Send JSON with `daily` and `perMinute`, each a positive integer.",
      });
      await seedUsage(api, issued.id, TODAY, 50);
      expect((await lookupWith(issued.key)).status).toBe(429);
    },
  );

  test("a per-minute limit past the 600-a-minute cap on keyed requests per client is 400 naming the cap; 600 itself is set", async () => {
    await start();
    const issued = await issue();

    const over = await limits(issued.id, { daily: 100_000, perMinute: 601 });
    expect(over.status).toBe(400);
    expect(await over.json()).toMatchObject({
      code: "invalid_request",
      detail:
        "`perMinute` can be at most 600: every client is capped at 600 requests a minute carrying an API key, before the key is read, so a higher limit is never reached.",
    });

    const atCap = await limits(issued.id, { daily: 100_000, perMinute: 600 });
    expect(atCap.status).toBe(200);
  });

  test.each(["PUT", "DELETE"])(
    "%s on an id that was never issued is 404 key_not_found",
    async (method) => {
      await start();

      const response = await admin(method, "/admin/keys/no-such-key/limits", {
        daily: 500,
        perMinute: 60,
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        code: "key_not_found",
        detail: "No key with id no-such-key.",
      });
    },
  );
});

describe("GET /admin/keys", () => {
  test("lists every key with its owner, status, tier, limits and usage today, and never a key or its hash", async () => {
    await start();
    const used = await issue("list@example.org");
    await limits(used.id, { daily: 500, perMinute: 60 });
    await lookupWith(used.key);
    await lookupWith(used.key);
    const revoked = await issue("list@example.org");
    await admin("POST", `/admin/keys/${revoked.id}/revoke`, {});
    await seedUsage(api, revoked.id, "2026-10-04", 7);

    const response = await admin("GET", "/admin/keys");

    expect(response.status).toBe(200);
    const text = await response.text();
    const listed = JSON.parse(text) as { day: string; keys: { id: string }[] };
    expect(listed.day).toBe(TODAY);
    expect(listed.keys).toHaveLength(2);
    expect(listed.keys.find(({ id }) => id === used.id)).toStrictEqual({
      id: used.id,
      name: null,
      ownerEmail: "list@example.org",
      status: "active",
      tier: "whitelisted",
      daily: 500,
      perMinute: 60,
      usedToday: 2,
    });
    expect(listed.keys.find(({ id }) => id === revoked.id)).toStrictEqual({
      id: revoked.id,
      name: null,
      ownerEmail: "list@example.org",
      status: "revoked",
      tier: "default",
      daily: 50,
      perMinute: 10,
      usedToday: 0,
    });
    const { rows } = await api.appDb.client.execute("SELECT key FROM apikey");
    for (const secret of [
      used.key,
      revoked.key,
      ...rows.map((r) => String(r.key)),
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("routing", () => {
  test.each([
    ["DELETE", "/admin/keys", "Use GET or POST.", "GET, HEAD, POST"],
    ["GET", "/admin/keys/some-id/revoke", "Use POST.", "POST"],
    ["POST", "/admin/keys/some-id/limits", "Use PUT or DELETE.", "PUT, DELETE"],
  ])(
    "%s %s is 405 naming the methods it takes",
    async (method, path, detail, allow) => {
      await start();

      const response = await admin(method, path);

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe(allow);
      expect(await response.json()).toMatchObject({
        code: "method_not_allowed",
        detail,
      });
    },
  );

  test("an admin path with no route is 404 route_not_found, after the gate", async () => {
    await start();

    expect((await admin("GET", "/admin/users", undefined, "")).status).toBe(
      401,
    );
    const response = await admin("GET", "/admin/users");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "route_not_found" });
  });
});
