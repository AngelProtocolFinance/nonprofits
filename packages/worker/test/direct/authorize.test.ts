import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { createTestHarness } from "wrangler";
import { admin } from "../../src/admin.ts";
import { authorize, bearerCredential, lookup } from "../../src/handlers.ts";
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
  await server.getWorker().applyD1Migrations("DB");
  env = (await server.getWorker().getEnv()) as Env;
});

afterEach(() => {
  vi.useRealTimers();
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
  await env.DB.prepare("UPDATE apikey SET expiresAt = ?1 WHERE id = ?2")
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

test("answers auth_unavailable, not invalid_api_key, when D1 is unreachable", async () => {
  const issued = await issueKey();

  const result = await authorize(
    { credential: issued.key, clientIp: null, cfWorker: null },
    {
      ...env,
      DB: failingD1(env.DB, /./),
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
    env: { ...env, DB: failingD1(env.DB, /insert into key_usage/i) },
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
        "The key check is unavailable right now; nothing is wrong with your key. Retry shortly.",
    },
  });
});

test("an issue that loses the race to create its owner reuses the winning owner", async () => {
  const email = "race@example.org";
  // a concurrent issue for the same new email commits its owner just before this one's insert
  const createWinner = () =>
    env.DB.prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('winner', ?1, ?1, 0, ?2, ?2)`,
    )
      .bind(email, new Date().toISOString())
      .run();
  const DB = {
    prepare: (sql: string) => {
      const statement = env.DB.prepare(sql);
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
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
    exec: (sql: string) => env.DB.exec(sql),
  } as unknown as D1Database;

  const response = await admin(adminRequest("/admin/keys", { email }), {
    ...env,
    DB,
  });

  expect(response.status).toBe(201);
  const issued = (await response.json()) as { id: string };
  const owner = await env.DB.prepare(
    `SELECT referenceId FROM apikey WHERE id = ?1`,
  )
    .bind(issued.id)
    .first();
  expect(owner).toStrictEqual({ referenceId: "winner" });
});

test("an admin call that fails in storage answers a problem 500, not a bare one", async () => {
  const response = await admin(
    adminRequest("/admin/keys", { email: "owner@example.org" }),
    { ...env, DB: failingD1(env.DB, /./) },
  );

  expect(response.status).toBe(500);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  expect(await response.json()).toMatchObject({ code: "internal_error" });
});
