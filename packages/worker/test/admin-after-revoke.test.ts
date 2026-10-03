import { afterAll, beforeAll, expect, test } from "vitest";
import { createWorkerHarness, postAdmin, testEnv } from "./harness.ts";

// Its own harness: the revoke below must be the first admin call this Worker
// isolate serves, so that it runs the key plugin's expired-key sweep (once per
// 10 s per isolate), which the plugin leaves running after the response.
const server = createWorkerHarness();

beforeAll(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("APP_DB");
});

afterAll(async () => {
  await server.close();
});

test("admin calls after a revoke still answer", async () => {
  const { APP_DB } = await testEnv(server);
  const now = new Date().toISOString();
  await APP_DB.batch([
    APP_DB.prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('owner', 'o@example.org', 'o@example.org', 0, ?1, ?1)`,
    ).bind(now),
    APP_DB.prepare(
      `INSERT INTO apikey (id, configId, referenceId, key, enabled, createdAt, updatedAt) VALUES ('seeded', 'default', 'owner', 'not-a-real-hash', 1, ?1, ?1)`,
    ).bind(now),
  ]);
  expect((await postAdmin(server, "/admin/keys/seeded/revoke")).status).toBe(
    200,
  );

  const created = await postAdmin(server, "/admin/keys", {
    email: "o@example.org",
  });

  expect(created.status).toBe(201);
}, 10_000);
