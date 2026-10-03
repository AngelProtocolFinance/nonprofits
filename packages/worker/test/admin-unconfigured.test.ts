import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestHarness } from "wrangler";

const server = createTestHarness({
  workers: [
    {
      configPath: new URL("../wrangler.jsonc", import.meta.url),
      secrets: {
        BETTER_AUTH_SECRET: "test-only-better-auth-secret-0123456789abcdef",
        ADMIN_TOKEN: "too-short",
      },
    },
  ],
});

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

test("admin endpoints stay shut when ADMIN_TOKEN is shorter than 32 characters, even to that token", async () => {
  const response = await server.fetch("/admin/keys", {
    method: "POST",
    headers: {
      authorization: "Bearer too-short",
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: "owner@example.org" }),
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: "admin_disabled",
    detail:
      "Admin endpoints are off: set the ADMIN_TOKEN secret to at least 32 random characters.",
  });
});
