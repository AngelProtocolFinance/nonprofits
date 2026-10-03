import { readFile } from "node:fs/promises";
import { rebuildSearchIndexSql } from "@nonprofits/db";
import { createTestHarness } from "wrangler";

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T>(): Promise<{ results: T[] }>;
}
export interface TestEnv {
  DB: {
    prepare(sql: string): D1Statement;
    batch(statements: D1Statement[]): Promise<unknown>;
  };
}

export const TEST_SECRETS = {
  BETTER_AUTH_SECRET: "test-only-better-auth-secret-0123456789abcdef",
  ADMIN_TOKEN: "test-only-admin-token-0123456789abcdef",
};

export const ADMIN_AUTHORIZATION = `Bearer ${TEST_SECRETS.ADMIN_TOKEN}`;

export type Harness = ReturnType<typeof createTestHarness>;

export function createWorkerHarness(
  secrets: Record<string, string> = TEST_SECRETS,
): Harness {
  return createTestHarness({
    workers: [
      { configPath: new URL("../wrangler.jsonc", import.meta.url), secrets },
    ],
  });
}

/** Splits a SQL file into statements; full-line `--` comments are dropped. */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function testEnv(server: Harness): Promise<TestEnv> {
  return (await server.getWorker().getEnv()) as unknown as TestEnv;
}

/** The search index rebuild an import runs after each load. */
export async function rebuildSearchIndex(server: Harness): Promise<void> {
  const { DB } = await testEnv(server);
  await DB.batch(
    statements(rebuildSearchIndexSql("")).map((s) => DB.prepare(s)),
  );
}

/** Starts the Worker on a migrated D1 holding `fixtures/seed.sql`, indexed for search. */
export async function listenSeeded(server: Harness): Promise<void> {
  await server.listen();
  const worker = server.getWorker();
  await worker.applyD1Migrations("DB");
  const { DB } = await testEnv(server);
  const seed = await readFile(
    new URL("../fixtures/seed.sql", import.meta.url),
    "utf8",
  );
  await DB.batch(statements(seed).map((s) => DB.prepare(s)));
  await rebuildSearchIndex(server);
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
