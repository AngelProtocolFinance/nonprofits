import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { createTestHarness } from "wrangler";
import { admin } from "../../src/admin.ts";
import { authorize, lookup } from "../../src/handlers.ts";

// typed against the Worker's globals, not node's: this file imports Worker source
const ADMIN_TOKEN = "test-only-admin-token-0123456789abcdef";
const server = createTestHarness({
  workers: [
    {
      configPath: new URL("../../wrangler.jsonc", import.meta.url),
      secrets: {
        BETTER_AUTH_SECRET: "test-only-better-auth-secret-0123456789abcdef",
        ADMIN_TOKEN,
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

/** The harness D1, except statements matching `fails` throw as an outage would. */
function failingD1(fails: RegExp): D1Database {
  const outage = () => {
    throw new Error("D1_ERROR: simulated storage outage");
  };
  return {
    prepare: (sql: string) =>
      fails.test(sql) ? outage() : env.DB.prepare(sql),
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
    exec: (sql: string) => (fails.test(sql) ? outage() : env.DB.exec(sql)),
    withSession: () => outage(),
    dump: () => outage(),
  } as D1Database;
}

test("the handler, called directly with no key, refuses before any lookup", async () => {
  const result = await lookup("530196605", {
    env,
    credential: null,
    now: new Date(),
  });
  expect(result).toMatchObject({
    ok: false,
    error: { code: "missing_api_key" },
  });
});

test("a key issued today still authorizes 8 days later", async () => {
  const issued = await issueKey();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(issued.createdAt) + 8 * DAY_MS);

  const result = await authorize(issued.key, env);

  expect(result).toStrictEqual({
    ok: true,
    value: {
      keyId: issued.id,
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

  const result = await authorize(issued.key, env);

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

  const result = await authorize(issued.key, { ...env, DB: failingD1(/./) });

  expect(result).toMatchObject({
    ok: false,
    error: { code: "auth_unavailable" },
  });
});

test("a request whose usage can't be counted answers auth_unavailable and is not served", async () => {
  const issued = await issueKey();

  const result = await lookup("530196605", {
    env: { ...env, DB: failingD1(/insert into key_usage/i) },
    credential: issued.key,
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
    { ...env, DB: failingD1(/./) },
  );

  expect(response.status).toBe(500);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  expect(await response.json()).toMatchObject({ code: "internal_error" });
});
