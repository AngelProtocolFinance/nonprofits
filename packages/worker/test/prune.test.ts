import { afterAll, beforeAll, expect, test } from "vitest";
import { createWorkerHarness, testEnv } from "./harness.ts";

const server = createWorkerHarness();

beforeAll(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
});

afterAll(async () => {
  await server.close();
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
