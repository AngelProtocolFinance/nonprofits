import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { createTestHarness } from "wrangler";
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
  const response = await server.fetch("/admin/keys", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: "owner@example.org" }),
  });
  const issued = (await response.json()) as {
    id: string;
    key: string;
    createdAt: string;
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(issued.createdAt) + 8 * DAY_MS);

  const result = await authorize(issued.key, env);

  expect(result).toStrictEqual({
    ok: true,
    value: { keyId: issued.id, tier: "default" },
  });
});
