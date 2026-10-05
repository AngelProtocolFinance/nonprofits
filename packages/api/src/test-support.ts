import { randomInt } from "node:crypto";
import { defaultKeyHasher } from "@better-auth/api-key";
import type { Client, InStatement } from "@libsql/client";
import { switchServedDatabase } from "@nonprofits/db";
import {
  appDbFixture,
  dataDbFixture,
  type LocalDb,
} from "@nonprofits/db/fixture";
import { dataDbClient } from "@nonprofits/db/node";
import { type ApiVars, createApp } from "./app.ts";
import { API_KEY_LETTERS, API_KEY_PREFIX } from "./authorize.ts";
import { memoryRateLimiter } from "./limiter.ts";
import {
  BURST_PERIOD_SECONDS,
  DEFAULT_LIMITS,
  KEYED_REQUESTS_PER_MINUTE,
  KEYLESS_LIMITS,
  KEYLESS_MCP_REQUESTS_PER_MINUTE,
} from "./quota.ts";
import { memorySearchCache, type SearchCache } from "./search-cache.ts";

const FIXTURE_BUILD = "20260910T030000Z";

export const TEST_VARS: ApiVars = {
  IP_HASH_SECRET: "test-only-ip-hash-secret-0123456789abcdef",
  SERVICE_KEYLESS_DAILY_LIMIT: "200000",
  ADMIN_TOKEN: "test-only-admin-token-0123456789abcdef",
  BETTER_AUTH_SECRET: "test-only-better-auth-secret-0123456789abcdef",
};

/** The header every admin call in a test sends. */
export const ADMIN_AUTHORIZATION = `Bearer ${TEST_VARS.ADMIN_TOKEN}`;

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
  /** The app database as the app sees it, e.g. one whose writes fail. */
  appDbAs?: (db: Client) => Client;
  /** Each data database the app opens, as the app sees it. */
  dataDbAs?: (db: Client) => Client;
  /** In place of the in-memory cache on the test's clock. */
  searchCache?: SearchCache;
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
  const perMinute = (limit: number) =>
    memoryRateLimiter({
      limit,
      periodSeconds: BURST_PERIOD_SECONDS,
      now: clock.now,
    });
  const app = createApp({
    appDb: options.appDbAs?.(appDb.client) ?? appDb.client,
    openDataDb: (url) => {
      const client = dataDbClient(url, {});
      clients.push(client);
      return options.dataDbAs?.(client) ?? client;
    },
    keylessBurst: perMinute(KEYLESS_LIMITS.perMinute),
    keyBurst: perMinute(DEFAULT_LIMITS.perMinute),
    keyedRequests: perMinute(KEYED_REQUESTS_PER_MINUTE),
    keylessMcpRequests: perMinute(KEYLESS_MCP_REQUESTS_PER_MINUTE),
    searchCache: options.searchCache ?? memorySearchCache(clock.now),
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

/** `key_usage` as `requests` admitted requests would leave `subject`'s day, without sending them. */
export async function seedUsage(
  api: TestApi,
  subject: string,
  day: string,
  requests: number,
) {
  await api.appDb.client.execute({
    sql: `INSERT INTO key_usage (subject, day, requests, minute, minute_requests)
          VALUES (?1, ?2, ?3, 0, 0)
          ON CONFLICT (subject, day) DO UPDATE SET requests = excluded.requests`,
    args: [subject, day, requests],
  });
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export interface TestKey {
  id: string;
  /** the key as its holder sends it */
  key: string;
}

export interface TestKeyOptions {
  /** 0 as `keys revoke` leaves it */
  enabled?: number;
  expiresAt?: string | null;
  /** a `key_limits` row, which makes the key whitelisted */
  limits?: { daily: number; perMinute: number };
}

let nextKey = 0;

/**
 * An `apikey` row as the plugin stores a key it issued, hashed with the
 * plugin's own hasher; issuing through better-auth is the key routes' job.
 */
export async function insertKey(
  api: TestApi,
  options: TestKeyOptions = {},
): Promise<TestKey> {
  nextKey += 1;
  const id = `test-key-${nextKey}`;
  const key = `${API_KEY_PREFIX}${Array.from({ length: API_KEY_LETTERS }, () => LETTERS[randomInt(LETTERS.length)]).join("")}`;
  const at = api.clock.now().toISOString();
  const statements: InStatement[] = [
    {
      sql: `INSERT INTO apikey (id, configId, referenceId, key, enabled, rateLimitEnabled, requestCount, expiresAt, createdAt, updatedAt)
            VALUES (?1, 'default', 'test-owner', ?2, ?3, 0, 0, ?4, ?5, ?5)`,
      args: [
        id,
        await defaultKeyHasher(key),
        options.enabled ?? 1,
        options.expiresAt ?? null,
        at,
      ],
    },
  ];
  if (options.limits !== undefined) {
    statements.push({
      sql: "INSERT INTO key_limits (key_id, daily, per_minute) VALUES (?1, ?2, ?3)",
      args: [id, options.limits.daily, options.limits.perMinute],
    });
  }
  await api.appDb.client.batch(statements, "write");
  return { id, key };
}

/** `db`, except that a statement whose SQL matches `failing` rejects as an unreachable store would. */
export function failingDb(db: Client, failing: RegExp): Client {
  const sqlOf = (statement: InStatement) =>
    typeof statement === "string" ? statement : statement.sql;
  return new Proxy(db, {
    get(target, property) {
      if (property === "execute") {
        return async (statement: InStatement) => {
          if (failing.test(sqlOf(statement))) {
            throw new Error("app database unreachable");
          }
          return target.execute(statement);
        };
      }
      if (property === "batch") {
        return async (statements: InStatement[], mode?: "read" | "write") => {
          if (statements.some((statement) => failing.test(sqlOf(statement)))) {
            throw new Error("app database unreachable");
          }
          return target.batch(statements, mode);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Every row of every table in the app database, each as JSON, by table. */
async function appDbRows(api: TestApi): Promise<Map<string, string[]>> {
  const db = api.appDb.client;
  const tables = await db.execute(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  const rows = new Map<string, string[]>();
  for (const { name } of tables.rows) {
    const table = String(name);
    const all = await db.execute(`SELECT * FROM "${table}"`);
    rows.set(
      table,
      all.rows.map((row) => JSON.stringify({ ...row })),
    );
  }
  return rows;
}

/**
 * The app database rows `act` inserts or changes, counted from a snapshot of
 * every table before and after, so a write no wrapper sees still counts. A
 * deleted row isn't counted: no request path deletes.
 */
export async function rowsWrittenBy(
  api: TestApi,
  act: () => unknown,
): Promise<number> {
  const before = await appDbRows(api);
  await act();
  const after = await appDbRows(api);
  let written = 0;
  for (const [table, rows] of after) {
    const kept = new Set(before.get(table));
    written += rows.filter((row) => !kept.has(row)).length;
  }
  return written;
}
