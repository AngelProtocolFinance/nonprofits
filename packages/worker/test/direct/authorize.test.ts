import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { createTestHarness } from "wrangler";
import { admin } from "../../src/admin.ts";
import {
  authorize,
  bearerCredential,
  clientRequestOf,
  lookup,
} from "../../src/handlers.ts";
import worker from "../../src/index.ts";
import { emptyServedData } from "./empty-data.ts";
import { failingD1 } from "./failing-d1.ts";

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

// node lacks workerd's timingSafeEqual, which admin() checks its token with
crypto.subtle.timingSafeEqual ??= (a, b) => {
  const [x, y] = [a, b].map((v) => new Uint8Array(v as ArrayBuffer));
  return x?.length === y?.length && !!x?.every((byte, i) => byte === y?.[i]);
};

function adminRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("APP_DB");
  env = (await server.getWorker().getEnv()) as Env;
  await emptyServedData(env);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await server.close();
});

const DAY_MS = 24 * 60 * 60 * 1000;

async function issueKey(): Promise<{
  id: string;
  key: string;
  createdAt: string;
}> {
  const response = await server.fetch("/admin/keys", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: "owner@example.org" }),
  });
  return (await response.json()) as {
    id: string;
    key: string;
    createdAt: string;
  };
}

test.each([
  ["unset", undefined],
  ["the public placeholder", "replace-with-32-plus-random-characters"],
])(
  "with IP_HASH_SECRET %s, a keyless request is refused unavailable, never hashed with a known key",
  async (_, secret) => {
    const result = await lookup("530196605", {
      env: { ...env, IP_HASH_SECRET: secret as string },
      credential: null,
      clientIp: "203.0.113.20",
      cfWorker: null,
      now: new Date(),
    });

    expect(result).toStrictEqual({
      ok: false,
      error: {
        code: "auth_unavailable",
        message:
          "Requests without an API key can't be served right now. Retry later, or send an API key.",
      },
    });
  },
);

test("with IP_HASH_SECRET unset, a request with a key is refused unavailable too: its client can't be counted", async () => {
  const issued = await issueKey();

  const result = await authorize(
    { credential: issued.key, clientIp: "203.0.113.22", cfWorker: null },
    { ...env, IP_HASH_SECRET: undefined as unknown as string },
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "auth_unavailable" },
  });
});

test("a request's client is its bearer key, CF-Connecting-IP and CF-Worker headers", () => {
  const request = new Request("http://localhost/mcp", {
    headers: {
      authorization: "Bearer npk_sent",
      "cf-connecting-ip": "203.0.113.23",
      "cf-worker": "zone.example",
    },
  });

  expect(clientRequestOf(request)).toStrictEqual({
    credential: "npk_sent",
    clientIp: "203.0.113.23",
    cfWorker: "zone.example",
  });
});

test("an empty Authorization header is refused as a malformed key, never served keyless", async () => {
  const result = await lookup("530196605", {
    env,
    credential: bearerCredential(""),
    clientIp: "203.0.113.21",
    cfWorker: null,
    now: new Date(),
  });

  expect(result).toMatchObject({
    ok: false,
    error: { code: "invalid_api_key" },
  });
});

test("a key issued today still authorizes 8 days later", async () => {
  const issued = await issueKey();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(issued.createdAt) + 8 * DAY_MS);

  const result = await authorize(
    { credential: issued.key, clientIp: null, cfWorker: null },
    env,
  );

  expect(result).toStrictEqual({
    ok: true,
    value: {
      subject: issued.id,
      tier: "default",
      limits: { daily: 50, perMinute: 10 },
    },
  });
});

test("a key past its expiresAt is refused as invalid", async () => {
  const issued = await issueKey();
  await env.APP_DB.prepare("UPDATE apikey SET expiresAt = ?1 WHERE id = ?2")
    .bind(new Date(Date.now() - 1000).toISOString(), issued.id)
    .run();

  const result = await authorize(
    { credential: issued.key, clientIp: null, cfWorker: null },
    env,
  );

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "invalid_api_key",
      message: expect.stringMatching(/^API key has expired\./),
    },
  });
});

test("a key stored as the plugin hashes it today authorizes: SHA-256, base64url, unpadded", async () => {
  // pinned: a plugin bump that hashes differently orphans every issued key, and goes red here
  const key = `npk_${"PinnedTestVector".repeat(4)}`;
  const storedHash = "Ac25xHNwCrIyozxh2F9Hp0KRq9B64pbTHVjOfwPoKIs";
  const now = new Date().toISOString();
  await env.APP_DB.prepare(
    `INSERT INTO apikey (id, configId, referenceId, key, enabled, rateLimitEnabled, requestCount, createdAt, updatedAt)
     VALUES ('pinned-key', 'default', 'pinned-owner', ?1, 1, 0, 0, ?2, ?2)`,
  )
    .bind(storedHash, now)
    .run();

  const result = await authorize(
    { credential: key, clientIp: null, cfWorker: null },
    env,
  );

  expect(result).toMatchObject({ ok: true, value: { subject: "pinned-key" } });
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
  "a key row carrying %s, which this guard doesn't enforce, is refused as invalid and logged by key id",
  async (_, assignment, fields) => {
    const issued = await issueKey();
    await env.APP_DB.prepare(`UPDATE apikey SET ${assignment} WHERE id = ?1`)
      .bind(issued.id)
      .run();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await authorize(
      { credential: issued.key, clientIp: null, cfWorker: null },
      env,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_api_key",
        message: expect.stringMatching(
          /^API key can't be used here: ask the operator for a new one\./,
        ),
      },
    });
    expect(
      errors.mock.calls.map(([line]) => JSON.parse(String(line))),
    ).toStrictEqual([
      { event: "api_key_unsupported_fields", keyId: issued.id, fields },
    ]);
  },
);

test("answers auth_unavailable, not invalid_api_key, when D1 is unreachable", async () => {
  const issued = await issueKey();

  const result = await authorize(
    { credential: issued.key, clientIp: null, cfWorker: null },
    {
      ...env,
      APP_DB: failingD1(env.APP_DB, /./),
    },
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "auth_unavailable" },
  });
});

test("a request whose usage can't be counted answers auth_unavailable and is not served", async () => {
  const issued = await issueKey();

  const result = await lookup("530196605", {
    env: { ...env, APP_DB: failingD1(env.APP_DB, /insert into key_usage/i) },
    credential: issued.key,
    clientIp: null,
    cfWorker: null,
    now: new Date(),
  });

  expect(result).toStrictEqual({
    ok: false,
    error: {
      code: "auth_unavailable",
      message:
        "The key check is unavailable right now, so this refusal says nothing about your key. Retry shortly.",
    },
  });
});

test("an issue that loses the race to create its owner reuses the winning owner", async () => {
  const email = "race@example.org";
  // a concurrent issue for the same new email commits its owner just before this one's insert
  const createWinner = () =>
    env.APP_DB.prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('winner', ?1, ?1, 0, ?2, ?2)`,
    )
      .bind(email, new Date().toISOString())
      .run();
  const APP_DB = {
    prepare: (sql: string) => {
      const statement = env.APP_DB.prepare(sql);
      if (!/^insert into "user"/i.test(sql)) return statement;
      return {
        bind: (...params: unknown[]) => ({
          all: async () => {
            await createWinner();
            return statement.bind(...params).all();
          },
        }),
      };
    },
    batch: (statements: D1PreparedStatement[]) => env.APP_DB.batch(statements),
    exec: (sql: string) => env.APP_DB.exec(sql),
  } as unknown as D1Database;

  const response = await admin(adminRequest("/admin/keys", { email }), {
    ...env,
    APP_DB,
  });

  expect(response.status).toBe(201);
  const issued = (await response.json()) as { id: string };
  const owner = await env.APP_DB.prepare(
    `SELECT referenceId FROM apikey WHERE id = ?1`,
  )
    .bind(issued.id)
    .first();
  expect(owner).toStrictEqual({ referenceId: "winner" });
});

test("an admin call that fails in storage answers a problem 500, not a bare one", async () => {
  const response = await admin(
    adminRequest("/admin/keys", { email: "owner@example.org" }),
    { ...env, APP_DB: failingD1(env.APP_DB, /./) },
  );

  expect(response.status).toBe(500);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  expect(await response.json()).toMatchObject({ code: "internal_error" });
});

test.each([
  ["unset", undefined],
  ["shorter than 32 characters", "too-short"],
  ["the public placeholder", "replace-with-32-plus-random-characters"],
])(
  "with BETTER_AUTH_SECRET %s, admin endpoints stay shut: 503 admin_disabled, never better-auth's built-in secret",
  async (_, secret) => {
    const response = await admin(
      adminRequest("/admin/keys", { email: "owner@example.org" }),
      { ...env, BETTER_AUTH_SECRET: secret as string },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "admin_disabled",
      detail:
        "Admin endpoints are off: set the BETTER_AUTH_SECRET secret to at least 32 random characters.",
    });
  },
);

/** A request through the Worker's `fetch`, which a request built here reaches without Cloudflare's `cf` properties the handlers never read. */
function viaWorker(
  path: string,
  workerEnv: Env,
  init: RequestInit = {},
): Promise<Response> {
  const request = new Request(`http://localhost${path}`, init);
  return worker.fetch(request as Parameters<typeof worker.fetch>[0], workerEnv);
}

const KEYLESS_UNAVAILABLE =
  "Requests without an API key can't be served right now. Retry later, or send an API key.";
const KEY_CHECK_UNAVAILABLE =
  "The key check is unavailable right now, so this refusal says nothing about your key. Retry shortly.";

test.each([
  {
    name: "a keyless REST request with IP_HASH_SECRET unset",
    path: "/v1/orgs/530196605",
    init: { headers: { "cf-connecting-ip": "203.0.113.23" } },
    broken: (): Partial<Env> => ({
      IP_HASH_SECRET: undefined as unknown as string,
    }),
    detail: KEYLESS_UNAVAILABLE,
  },
  {
    name: "a keyless MCP request with IP_HASH_SECRET unset",
    path: "/mcp",
    init: {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.24" },
    },
    broken: (): Partial<Env> => ({
      IP_HASH_SECRET: undefined as unknown as string,
    }),
    detail: KEYLESS_UNAVAILABLE,
  },
  {
    name: "a REST request with a key while the key store can't be read",
    path: "/v1/orgs/530196605",
    init: { headers: { authorization: `Bearer npk_${"Q".repeat(64)}` } },
    broken: (): Partial<Env> => ({ APP_DB: failingD1(env.APP_DB, /./) }),
    detail: KEY_CHECK_UNAVAILABLE,
  },
])(
  "$name is a 503 auth_unavailable problem over HTTP, with no challenge and no Retry-After, and logs its cause",
  async ({ path, init, broken, detail }) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await viaWorker(path, { ...env, ...broken() }, init);

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
      detail,
    });
    expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual(
      [expect.objectContaining({ event: "auth_unavailable" })],
    );
  },
);
