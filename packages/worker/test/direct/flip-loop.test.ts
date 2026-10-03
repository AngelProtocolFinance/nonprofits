import {
  claimSlotSql,
  type DataSlot,
  flipActiveSlotSql,
  resetGenerationSql,
  sealGenerationSql,
} from "@nonprofits/db";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestHarness } from "wrangler";
import { type Caller, lookupAs } from "../../src/handlers.ts";
import { runSql } from "../d1-sql.ts";

const server = createTestHarness({
  workers: [{ configPath: new URL("../../wrangler.jsonc", import.meta.url) }],
});
let env: Env;

const RED_CROSS = "530196605";

/** A sealed generation in `slot` whose Red Cross is named `name`. */
async function build(slot: DataSlot, buildId: string, name: string) {
  const db = slot === "a" ? env.DATA_DB_A : env.DATA_DB_B;
  await runSql(db, resetGenerationSql(slot, buildId));
  await db.batch([
    db.prepare(
      "INSERT INTO import_runs VALUES (1, 'bmf', 'https://example.invalid/bmf', '2026-09-08', '2026-09-10', 1)",
    ),
    db
      .prepare("INSERT INTO orgs (ein, name, name_run_id) VALUES (?1, ?2, 1)")
      .bind(RED_CROSS, name),
  ]);
  await db.prepare(sealGenerationSql(buildId)).run();
}

beforeAll(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("APP_DB");
  env = (await server.getWorker().getEnv()) as Env;
  // slot a went live as build-a; build-b is claimed and built in b, not yet flipped
  await build("a", "build-a", "SLOT A");
  await env.APP_DB.prepare(
    "UPDATE data_generation SET build_id = 'build-a'",
  ).run();
  await env.APP_DB.prepare(claimSlotSql("b", "build-b")).run();
  await build("b", "build-b", "SLOT B");
});

afterAll(async () => {
  await server.close();
});

const T0 = Date.parse("2026-10-03T12:00:00Z");

/**
 * Flips from `from` to the other slot, sealed for `buildId`, then moves the
 * flip `secondsAgo` back by the database's clock. The rollback from b claims a
 * first; b was claimed when it was built.
 */
async function flip(
  from: DataSlot,
  to: DataSlot,
  buildId: string,
  secondsAgo = 0,
) {
  if (from === "b") {
    await env.APP_DB.prepare(claimSlotSql(to, buildId)).run();
  }
  const { results } = await env.APP_DB.prepare(
    flipActiveSlotSql(from, buildId),
  ).all();
  expect(results).toHaveLength(1);
  await env.APP_DB.prepare(
    "UPDATE data_generation SET flipped_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?1)",
  )
    .bind(`-${secondsAgo} seconds`)
    .run();
}

test("a lookup a second across a flip and a rollback: never a failure, every flip served within 30 s", async () => {
  const served: string[] = [];
  // the rollback's claim is checked against the database's clock, 60 s after
  // the flip it undoes, so that flip is moved 2 min back
  for (let second = 0; second < 120; second++) {
    if (second === 20) await flip("a", "b", "build-b", 120);
    if (second === 70) await flip("b", "a", "build-a");
    const caller: Caller = {
      env,
      now: new Date(T0 + second * 1000),
      principal: {
        subject: "flip-loop",
        tier: "whitelisted",
        limits: { daily: 1_000_000, perMinute: 1_000_000 },
      },
    };
    const result = await lookupAs(RED_CROSS, caller);
    served.push(
      result.ok ? (result.value.name ?? "unnamed") : result.error.code,
    );
  }

  const toB = served.indexOf("SLOT B");
  const backToA = served.indexOf("SLOT A", toB);
  expect(toB).toBeGreaterThanOrEqual(20);
  expect(toB).toBeLessThanOrEqual(50);
  expect(backToA).toBeGreaterThanOrEqual(70);
  expect(backToA).toBeLessThanOrEqual(100);
  expect(served).toStrictEqual([
    ...Array(toB).fill("SLOT A"),
    ...Array(backToA - toB).fill("SLOT B"),
    ...Array(120 - backToA).fill("SLOT A"),
  ]);
});
