import {
  type DataSlot,
  READ_DATA_META_SQL,
  resetGenerationSql,
  sealGenerationSql,
} from "@nonprofits/db";
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
  await build(env.DATA_DB_A, "a", "build-a");
  await build(env.DATA_DB_B, "b", "build-b");
});

/** An empty generation in `slot`, sealed for `buildId`. */
async function build(db: D1Database, slot: DataSlot, buildId: string) {
  await runSql(db, resetGenerationSql(slot, buildId));
  await db.prepare(sealGenerationSql(buildId)).run();
}

afterAll(async () => {
  await server.close();
});

const T0 = Date.parse("2026-10-03T12:00:00Z");

/** Sets the pointer as a flip would leave it. */
async function point(slot: DataSlot, buildId = `build-${slot}`) {
  await env.APP_DB.prepare(
    "UPDATE data_generation SET active = ?1, build_id = ?2",
  )
    .bind(slot, buildId)
    .run();
}

/** Which slot the served data DB says it is. */
async function slotOf(served: { db: D1Database }) {
  return (await served.db.prepare(READ_DATA_META_SQL).first<{ slot: string }>())
    ?.slot;
}

test("serves the data DB the pointer names, with the build it holds", async () => {
  await point("b");

  const served = await createActiveDataDb()(env, T0);

  expect(await slotOf(served)).toBe("b");
  expect(served.buildId).toBe("build-b");
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

  expect(await slotOf(await activeDataDb(pointerDown, T0 + 45_000))).toBe("b");
});

test("fails when the pointer can't be read and no slot was ever read", async () => {
  const pointerDown = { ...env, APP_DB: failingD1(env.APP_DB, /./) };

  await expect(createActiveDataDb()(pointerDown, T0)).rejects.toThrow(
    "simulated storage outage",
  );
});

test("fails when the pointer names a slot not sealed for its build and none was served", async () => {
  await point("b", "build-x");

  await expect(createActiveDataDb()(env, T0)).rejects.toThrow(
    "slot b is not sealed for build build-x",
  );
});

test("after a failed pointer read, serves the last slot without reading until 60 s past its last good read, then fails until a read succeeds", async () => {
  const activeDataDb = createActiveDataDb();
  await point("b");
  await activeDataDb(env, T0);
  let reads = 0;
  const pointerDown = {
    ...env,
    APP_DB: {
      prepare: () => {
        reads++;
        throw new Error("D1_ERROR: simulated storage outage");
      },
    } as unknown as D1Database,
  };

  const firstFailure = await activeDataDb(pointerDown, T0 + 30_000);
  const lastFallback = await activeDataDb(pointerDown, T0 + 59_999);
  const expired = activeDataDb(pointerDown, T0 + 60_000);
  await expect(expired).rejects.toThrow("simulated storage outage");
  await expect(activeDataDb(pointerDown, T0 + 90_000)).rejects.toThrow(
    "simulated storage outage",
  );
  const recovered = await activeDataDb(env, T0 + 90_001);

  expect([
    await slotOf(firstFailure),
    await slotOf(lastFallback),
    await slotOf(recovered),
  ]).toEqual(["b", "b", "b"]);
  expect(reads).toBe(3);
});

test("an isolate idle since its last read 60 s or more ago fails rather than serve that slot", async () => {
  const activeDataDb = createActiveDataDb();
  await point("b");
  await activeDataDb(env, T0);
  const pointerDown = { ...env, APP_DB: failingD1(env.APP_DB, /./) };

  await expect(activeDataDb(pointerDown, T0 + 100_000)).rejects.toThrow(
    "simulated storage outage",
  );
});

test("a read that succeeds between failures restarts the 60 s", async () => {
  const activeDataDb = createActiveDataDb();
  await point("b");
  await activeDataDb(env, T0);
  const pointerDown = { ...env, APP_DB: failingD1(env.APP_DB, /./) };

  await activeDataDb(pointerDown, T0 + 30_000);
  await activeDataDb(env, T0 + 60_000);
  const afterRecovery = await activeDataDb(pointerDown, T0 + 90_000);

  expect(await slotOf(afterRecovery)).toBe("b");
});

// last: it leaves slot b on another build
test("while the pointer names a slot not sealed for its build, keeps the slot it served until 60 s past its last good read, then fails until the slot is sealed", async () => {
  const activeDataDb = createActiveDataDb();
  await point("a");
  await activeDataDb(env, T0);

  await point("b", "build-x");
  const mismatched = await activeDataDb(env, T0 + 30_000);
  await runSql(env.DATA_DB_B, resetGenerationSql("b", "build-b2"));
  await point("b", "build-b2");
  const building = activeDataDb(env, T0 + 60_000);
  await expect(building).rejects.toThrow(
    "slot b is not sealed for build build-b2",
  );
  await env.DATA_DB_B.prepare(sealGenerationSql("build-b2")).run();
  const sealed = await activeDataDb(env, T0 + 60_001);

  expect([await slotOf(mismatched), await slotOf(sealed)]).toEqual(["a", "b"]);
  expect(sealed.buildId).toBe("build-b2");
});
