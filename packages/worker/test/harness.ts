import { readFile } from "node:fs/promises";
import {
  DATA_DB_BINDING,
  type DataSlot,
  rebuildSearchIndexSql,
  resetGenerationSql,
} from "@nonprofits/db";
import { createTestHarness } from "wrangler";
import { runSql } from "./d1-sql.ts";

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T>(): Promise<{ results: T[] }>;
}
interface TestD1 {
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

/** The search index rebuild an import runs after each load, on `slot`'s data DB. */
export async function rebuildSearchIndex(
  server: Harness,
  slot: DataSlot = "a",
): Promise<void> {
  const env = await testEnv(server);
  await runSql(env[DATA_DB_BINDING[slot]], rebuildSearchIndexSql(""));
}

/** Resets `slot`'s data DB to an empty generation. */
export async function resetDataSlot(
  server: Harness,
  slot: DataSlot,
): Promise<void> {
  const db = (await testEnv(server))[DATA_DB_BINDING[slot]];
  await runSql(db, resetGenerationSql(slot, `test-${slot}`));
}

/** Resets `slot`'s data DB and fills it with `fixtures/seed.sql`, indexed for search. */
export async function seedDataSlot(
  server: Harness,
  slot: DataSlot,
): Promise<void> {
  await resetDataSlot(server, slot);
  const seed = await readFile(
    new URL("../fixtures/seed.sql", import.meta.url),
    "utf8",
  );
  await runSql((await testEnv(server))[DATA_DB_BINDING[slot]], seed);
  await rebuildSearchIndex(server, slot);
}

/**
 * Starts the Worker on a migrated app DB, with data slot a (the one the
 * pointer starts on) holding `fixtures/seed.sql`.
 */
export async function listenSeeded(server: Harness): Promise<void> {
  await server.listen();
  await server.getWorker().applyD1Migrations("APP_DB");
  await seedDataSlot(server, "a");
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
    body: JSON.stringify({ daily: 100_000, perMinute: 10_000 }),
  });
  if (response.status !== 200) {
    throw new Error(
      `whitelisting a key: ${response.status} ${await response.text()}`,
    );
  }
  return issued;
}
