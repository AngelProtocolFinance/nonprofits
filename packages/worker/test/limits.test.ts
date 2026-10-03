import { afterAll, beforeAll, expect, test } from "vitest";
import { clearOfUtcMidnight } from "./clock-windows.ts";
import {
  createWorkerHarness,
  issueKey,
  issueWhitelistedKey,
  listenSeeded,
  TEST_SECRETS,
} from "./harness.ts";

const SERVICE_KEY_DAILY_LIMIT = 3;
const server = createWorkerHarness(TEST_SECRETS, { SERVICE_KEY_DAILY_LIMIT });

beforeAll(async () => {
  await listenSeeded(server);
});

afterAll(async () => {
  await server.close();
});

function get(path: string, authorization?: string): Promise<Response> {
  return server.fetch(path, {
    headers: authorization === undefined ? {} : { authorization },
  });
}

function secondsToUtcMidnight(): number {
  const midnight = new Date();
  midnight.setUTCHours(24, 0, 0, 0);
  return Math.ceil((midnight.getTime() - Date.now()) / 1000);
}

test("past the service-wide daily limit a default key gets 429 service_daily_limit_reached with Retry-After up to UTC midnight; a whitelisted key does not", async () => {
  const bearer = `Bearer ${(await issueKey(server)).key}`;
  const whitelisted = `Bearer ${(await issueWhitelistedKey(server)).key}`;
  await clearOfUtcMidnight();
  for (let i = 1; i <= SERVICE_KEY_DAILY_LIMIT; i++) {
    expect((await get("/v1/orgs/530196605", bearer)).status).toBe(200);
  }

  const response = await get("/v1/search?q=red", bearer);

  expect(response.status).toBe(429);
  const retryAfter = Number(response.headers.get("retry-after"));
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(secondsToUtcMidnight() + 1);
  expect(await response.json()).toMatchObject({
    status: 429,
    code: "service_daily_limit_reached",
  });
  expect((await get("/v1/orgs/530196605", whitelisted)).status).toBe(200);
});
