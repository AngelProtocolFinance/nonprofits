import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createWorkerHarness, TEST_SECRETS } from "./harness.ts";

const devVarsExample = await readFile(
  new URL("../.dev.vars.example", import.meta.url),
  "utf8",
);
const placeholder = /^ADMIN_TOKEN=(.+)$/m.exec(devVarsExample)?.[1] ?? "";

describe.each([
  ["shorter than 32 characters", "too-short"],
  ["still the .dev.vars.example placeholder", placeholder],
])("admin endpoints, with ADMIN_TOKEN %s", (_, adminToken) => {
  const server = createWorkerHarness({
    ...TEST_SECRETS,
    ADMIN_TOKEN: adminToken,
  });

  beforeAll(async () => {
    await server.listen();
  });

  afterAll(async () => {
    await server.close();
  });

  test("stay shut even to that token: 503 admin_disabled", async () => {
    expect(adminToken).not.toBe("");
    const response = await server.fetch("/admin/keys", {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
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
});
