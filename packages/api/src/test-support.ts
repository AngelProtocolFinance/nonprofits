import type { Client } from "@libsql/client";
import { switchServedDatabase } from "@nonprofits/db";
import {
  appDbFixture,
  dataDbFixture,
  type LocalDb,
} from "@nonprofits/db/fixture";
import { dataDbClient } from "@nonprofits/db/node";
import { type ApiVars, createApp } from "./app.ts";
import { memoryRateLimiter } from "./limiter.ts";
import { BURST_PERIOD_SECONDS, KEYLESS_LIMITS } from "./quota.ts";

const FIXTURE_BUILD = "20260910T030000Z";

export const TEST_VARS: ApiVars = {
  IP_HASH_SECRET: "test-only-ip-hash-secret-0123456789abcdef",
  SERVICE_KEYLESS_DAILY_LIMIT: "200000",
};

/** A clock the test moves; it starts mid-day, clear of a UTC midnight. */
export function testClock(start = "2026-10-05T12:00:00Z") {
  let at = new Date(start);
  return {
    now: () => at,
    set(iso: string) {
      at = new Date(iso);
    },
    advance(ms: number) {
      at = new Date(at.getTime() + ms);
    },
  };
}

export type TestClock = ReturnType<typeof testClock>;

export interface TestApi {
  app: ReturnType<typeof createApp>;
  appDb: LocalDb;
  dataDb: LocalDb;
  clock: TestClock;
  dispose(): Promise<void>;
}

export interface TestApiOptions {
  vars?: Partial<ApiVars>;
  /** Rows written to the data fixture before the app serves it. */
  fill?: (data: Client) => Promise<void>;
  /** false leaves the pointer as a fresh app database has it: never built. */
  serve?: boolean;
}

/**
 * The app over a migrated app database whose pointer serves the data
 * fixture, with the in-memory limiter on the test's clock.
 */
export async function testApi(options: TestApiOptions = {}): Promise<TestApi> {
  const appDb = await appDbFixture();
  const dataDb = await dataDbFixture(FIXTURE_BUILD);
  await options.fill?.(dataDb.client);
  if (options.serve !== false) {
    await switchServedDatabase(appDb.client, {
      expected: null,
      to: { name: "nonprofits-fixture", url: dataDb.url },
      buildId: FIXTURE_BUILD,
    });
  }
  const clock = testClock();
  const clients: Client[] = [];
  const app = createApp({
    appDb: appDb.client,
    openDataDb: (url) => {
      const client = dataDbClient(url, {});
      clients.push(client);
      return client;
    },
    keylessBurst: memoryRateLimiter({
      limit: KEYLESS_LIMITS.perMinute,
      periodSeconds: BURST_PERIOD_SECONDS,
      now: clock.now,
    }),
    now: clock.now,
    vars: { ...TEST_VARS, ...options.vars },
  });
  return {
    app,
    appDb,
    dataDb,
    clock,
    async dispose() {
      for (const client of clients) client.close();
      await appDb.dispose();
      await dataDb.dispose();
    },
  };
}

let nextClient = 0;

/** Headers for a keyless request from a client no other request in the run comes from. */
export function freshClient(): { "x-real-ip": string } {
  nextClient += 1;
  return {
    "x-real-ip": `10.${(nextClient >> 16) & 255}.${(nextClient >> 8) & 255}.${nextClient & 255}`,
  };
}

/** Every `key_usage` row: a request refused before it was counted adds none. */
export async function usageRows(api: TestApi): Promise<number> {
  const rows = await api.appDb.client.execute(
    "SELECT count(*) AS n FROM key_usage",
  );
  return Number(rows.rows[0]?.n);
}
