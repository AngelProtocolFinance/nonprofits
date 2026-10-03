import { readFile } from "node:fs/promises";
import {
  DATA_DB_BINDING,
  type DataSlot,
  rebuildSearchIndexSql,
  resetGenerationSql,
  sealGenerationSql,
} from "@nonprofits/db";
import { createTestHarness } from "wrangler";
import { runSql } from "./d1-sql.ts";

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T>(): Promise<{ results: T[] }>;
}
export interface TestD1 {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown>;
}
export interface TestEnv {
  APP_DB: TestD1;
  DATA_DB_A: TestD1;
  DATA_DB_B: TestD1;
}

export const TEST_SECRETS = {
  BETTER_AUTH_SECRET: "test-only-better-auth-secret-0123456789abcdef",
  ADMIN_TOKEN: "test-only-admin-token-0123456789abcdef",
  IP_HASH_SECRET: "test-only-ip-hash-secret-0123456789abcdef",
};

export const ADMIN_AUTHORIZATION = `Bearer ${TEST_SECRETS.ADMIN_TOKEN}`;

export type Harness = ReturnType<typeof createTestHarness>;

export function createWorkerHarness(
  secrets: Record<string, string> = TEST_SECRETS,
  vars: Record<string, number> = {},
): Harness {
  return createTestHarness({
    workers: [
      {
        configPath: new URL("../wrangler.jsonc", import.meta.url),
        secrets,
        vars,
      },
    ],
  });
}

export async function testEnv(server: Harness): Promise<TestEnv> {
  return (await server.getWorker().getEnv()) as unknown as TestEnv;
}

/**
 * `WITH RECURSIVE n(i)` numbering `count` rows from 0, ahead of an
 * `INSERT … SELECT … FROM n`: a bound statement per filler row takes seconds
 * in D1, one statement over the series takes milliseconds.
 */
export function series(count: number): string {
  return `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${count - 1})`;
}

/** Rows a test writes into a data DB before it is sealed. */
export type Fill = (db: TestD1) => Promise<void>;

/** Fills a data DB with `fixtures/seed.sql`, then whatever `fill` adds. */
export function seeded(fill?: Fill): Fill {
  return async (db) => {
    const seed = await readFile(
      new URL("../fixtures/seed.sql", import.meta.url),
      "utf8",
    );
    await runSql(db, seed);
    await fill?.(db);
  };
}

/**
 * Builds `slot` as an import does: reset for `buildId`, filled, its search
 * index rebuilt, then sealed, after which it takes no writes.
 */
export async function buildDataSlot(
  server: Harness,
  slot: DataSlot,
  buildId: string,
  fill?: Fill,
): Promise<void> {
  const db = (await testEnv(server))[DATA_DB_BINDING[slot]];
  await runSql(db, resetGenerationSql(slot, buildId));
  await fill?.(db);
  await runSql(db, rebuildSearchIndexSql(buildId));
  await db.prepare(sealGenerationSql(buildId)).all();
}

/**
 * `buildDataSlot`, then the pointer set on `slot` and `buildId` as a flip
 * leaves it, without the claim a real flip needs.
 */
export async function serveDataSlot(
  server: Harness,
  slot: DataSlot,
  buildId: string,
  fill?: Fill,
): Promise<void> {
  await buildDataSlot(server, slot, buildId, fill);
  const { APP_DB } = await testEnv(server);
  await APP_DB.prepare("UPDATE data_generation SET active = ?1, build_id = ?2")
    .bind(slot, buildId)
    .all();
}

/**
 * Reloads the Worker with its storage kept: a fresh isolate reads the pointer
 * on its first data request, as every isolate does within `POINTER_TTL_MS` of
 * a flip. A test that rebuilds the served slot in place needs it before the
 * Worker sees the new build.
 */
export async function reloadWorker(server: Harness): Promise<void> {
  await server.update((options) => options);
}

/**
 * Starts the Worker on a migrated app DB serving slot a, which holds
 * `fixtures/seed.sql` and whatever `fill` adds.
 */
export async function listenSeeded(
  server: Harness,
  fill?: Fill,
): Promise<void> {
  await server.listen();
  await server.getWorker().applyD1Migrations("APP_DB");
  await serveDataSlot(server, "a", "seed-a", seeded(fill));
}

export interface IssuedKey {
  id: string;
  key: string;
  name: string | null;
  ownerEmail: string;
  createdAt: string;
  expiresAt: string | null;
}

export function postAdmin(
  server: Harness,
  path: string,
  body: unknown = {},
): Promise<Response> {
  return server.fetch(path, {
    method: "POST",
    headers: {
      authorization: ADMIN_AUTHORIZATION,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export async function issueKey(
  server: Harness,
  email = "owner@example.org",
): Promise<IssuedKey> {
  const response = await postAdmin(server, "/admin/keys", { email });
  if (response.status !== 201) {
    throw new Error(
      `issuing a key: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as IssuedKey;
}

/** A key past the default tier's limits, for tests about data rather than limits. */
export async function issueWhitelistedKey(server: Harness): Promise<IssuedKey> {
  const issued = await issueKey(server, "whitelisted@example.org");
  const response = await server.fetch(`/admin/keys/${issued.id}/limits`, {
    method: "PUT",
    headers: {
      authorization: ADMIN_AUTHORIZATION,
      "content-type": "application/json",
    },
    body: JSON.stringify({ daily: 100_000, perMinute: 600 }),
  });
  if (response.status !== 200) {
    throw new Error(
      `whitelisting a key: ${response.status} ${await response.text()}`,
    );
  }
  return issued;
}
