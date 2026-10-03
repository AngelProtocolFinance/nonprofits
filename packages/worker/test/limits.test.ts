import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createWorkerHarness,
  issueKey,
  issueWhitelistedKey,
  listenSeeded,
  TEST_SECRETS,
  testEnv,
} from "./harness.ts";

const SERVICE_DAILY_LIMIT = 3;
const server = createWorkerHarness(TEST_SECRETS, { SERVICE_DAILY_LIMIT });

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
  for (let i = 1; i <= SERVICE_DAILY_LIMIT; i++) {
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

test("the daily cron prunes usage rows more than 7 days older than its run, and keeps the rest", async () => {
  const { DB } = await testEnv(server);
  const days = ["2026-12-10", "2026-12-12", "2026-12-13", "2026-12-19"];
  await DB.batch(
    days.map((day) =>
      DB.prepare(
        "INSERT INTO key_usage (subject, day, requests, minute, minute_requests) VALUES (?1, ?2, 1, 0, 1)",
      ).bind(`prune-test:${day}`, day),
    ),
  );

  const run = await server.getWorker().scheduled({
    cron: "17 3 * * *",
    scheduledTime: new Date("2026-12-20T03:17:00Z"),
  });

  expect(run.outcome).toBe("ok");
  const { results } = await DB.prepare(
    "SELECT day FROM key_usage WHERE subject LIKE 'prune-test:%' ORDER BY day",
  ).all<{ day: string }>();
  expect(results).toStrictEqual([{ day: "2026-12-13" }, { day: "2026-12-19" }]);
});
