import { READ_DATA_META_SQL, resetGenerationSql } from "@nonprofits/db";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestHarness } from "wrangler";
import { createActiveDataDb } from "../../src/data-db.ts";
import { runSql } from "../d1-sql.ts";
import { failingD1 } from "./failing-d1.ts";

const server = createTestHarness({
  workers: [{ configPath: new URL("../../wrangler.jsonc", import.meta.url) }],
});
let env: Env;

beforeAll(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("APP_DB");
  env = (await server.getWorker().getEnv()) as Env;
  await runSql(env.DATA_DB_A, resetGenerationSql("a", "build-a"));
  await runSql(env.DATA_DB_B, resetGenerationSql("b", "build-b"));
});

afterAll(async () => {
  await server.close();
});

const T0 = Date.parse("2026-10-03T12:00:00Z");

async function point(slot: "a" | "b") {
  await env.APP_DB.prepare("UPDATE data_generation SET active = ?1")
    .bind(slot)
    .run();
}

/** Which slot a data DB says it is. */
async function slotOf(db: D1Database) {
  return (await db.prepare(READ_DATA_META_SQL).first<{ slot: string }>())?.slot;
}

test("serves the data DB the pointer names", async () => {
  await point("b");

  expect(await slotOf(await createActiveDataDb()(env, T0))).toBe("b");
});

test("keeps serving the slot it read for 30 s, then reads the pointer again", async () => {
  const activeDataDb = createActiveDataDb();
  await point("a");
  await activeDataDb(env, T0);
  await point("b");

  expect(await slotOf(await activeDataDb(env, T0 + 29_999))).toBe("a");
  expect(await slotOf(await activeDataDb(env, T0 + 30_000))).toBe("b");
});

test("serves the last slot it read while the pointer can't be read", async () => {
  const activeDataDb = createActiveDataDb();
  await point("b");
  await activeDataDb(env, T0);
  const pointerDown = { ...env, APP_DB: failingD1(env.APP_DB, /./) };

  expect(await slotOf(await activeDataDb(pointerDown, T0 + 60_000))).toBe("b");
});

test("fails when the pointer can't be read and no slot was ever read", async () => {
  const pointerDown = { ...env, APP_DB: failingD1(env.APP_DB, /./) };

  await expect(createActiveDataDb()(pointerDown, T0)).rejects.toThrow(
    "simulated storage outage",
  );
});
