import { afterAll, beforeAll, expect, test } from "vitest";
import { createWorkerHarness, testEnv } from "./harness.ts";
import { virtualAt, virtualDay } from "./virtual-clock.ts";

const server = createWorkerHarness();

beforeAll(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("APP_DB");
});

afterAll(async () => {
  await server.close();
});

test("the daily cron prunes usage rows more than 7 days older than its run, and keeps the rest", async () => {
  const { APP_DB } = await testEnv(server);
  const days = [10, 12, 13, 19].map(virtualDay);
  await APP_DB.batch(
    days.map((day) =>
      APP_DB.prepare(
        "INSERT INTO key_usage (subject, day, requests, minute, minute_requests) VALUES (?1, ?2, 1, 0, 1)",
      ).bind(`prune-test:${day}`, day),
    ),
  );

  const run = await server.getWorker().scheduled({
    cron: "17 3 * * *",
    scheduledTime: new Date(virtualAt(20, "03:17:00")),
  });

  expect(run.outcome).toBe("ok");
  const { results } = await APP_DB.prepare(
    "SELECT day FROM key_usage WHERE subject LIKE 'prune-test:%' ORDER BY day",
  ).all<{ day: string }>();
  expect(results).toStrictEqual([
    { day: virtualDay(13) },
    { day: virtualDay(19) },
  ]);
});
