import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { dataDbClient } from "@nonprofits/db/node";
import { createApp } from "./app.ts";
import { devDatabases } from "./dev-databases.ts";
import { memoryRateLimiter } from "./limiter.ts";
import {
  BURST_PERIOD_SECONDS,
  DEFAULT_LIMITS,
  KEYED_REQUESTS_PER_MINUTE,
  KEYLESS_LIMITS,
  KEYLESS_MCP_REQUESTS_PER_MINUTE,
} from "./quota.ts";
import { memorySearchCache } from "./search-cache.ts";
import { PLACEHOLDER_PREFIX } from "./secret.ts";

// Serves the api on localhost over the data database the pointer in
// TURSO_APP_DB_URL names, else in `.turso/app.db` once `irs refresh` has
// published one, else over fresh fixture databases; it logs which. The admin
// routes stay off until `packages/api/.env.local` (ignored; the cli's `keys`
// script reads it too) sets ADMIN_TOKEN and BETTER_AUTH_SECRET, each from
// `openssl rand -base64 32`.
const databases = await devDatabases({
  TURSO_APP_DB_URL: envVar("TURSO_APP_DB_URL"),
  TURSO_APP_DB_TOKEN: envVar("TURSO_APP_DB_TOKEN"),
});

/** An empty or placeholder value reads as unset, so a copy of `.env.example` serves as no file would. */
function envVar(name: string): string | undefined {
  const value = process.env[name];
  return value === "" || value?.startsWith(PLACEHOLDER_PREFIX)
    ? undefined
    : value;
}

const now = () => new Date();
const perMinute = (limit: number) =>
  memoryRateLimiter({ limit, periodSeconds: BURST_PERIOD_SECONDS, now });
const app = createApp({
  appDb: databases.appDb,
  openDataDb: (url) => dataDbClient(url, process.env),
  keylessBurst: perMinute(KEYLESS_LIMITS.perMinute),
  keyBurst: perMinute(DEFAULT_LIMITS.perMinute),
  keyedRequests: perMinute(KEYED_REQUESTS_PER_MINUTE),
  keylessMcpRequests: perMinute(KEYLESS_MCP_REQUESTS_PER_MINUTE),
  searchCache: memorySearchCache(now),
  now,
  fetch,
  vars: {
    // unless set, a fresh key per run: a restart starts each keyless client's day over
    IP_HASH_SECRET:
      envVar("IP_HASH_SECRET") ?? randomBytes(32).toString("base64url"),
    SERVICE_KEYLESS_DAILY_LIMIT: envVar("SERVICE_KEYLESS_DAILY_LIMIT"),
    SERVICE_KEY_DAILY_LIMIT: envVar("SERVICE_KEY_DAILY_LIMIT"),
    ADMIN_TOKEN: envVar("ADMIN_TOKEN"),
    BETTER_AUTH_SECRET: envVar("BETTER_AUTH_SECRET"),
    CRON_SECRET: envVar("CRON_SECRET"),
    GITHUB_REPO: envVar("GITHUB_REPO"),
    STALE_AFTER_DAYS: envVar("STALE_AFTER_DAYS"),
    REDISPATCH_AFTER_HOURS: envVar("REDISPATCH_AFTER_HOURS"),
    GITHUB_DISPATCH_TOKEN: envVar("GITHUB_DISPATCH_TOKEN"),
  },
});

const port = Number(process.env.PORT ?? 8787);
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(
    `api on http://localhost:${port} serving ${databases.serving} from ${databases.from}`,
  );
});

async function shutdown() {
  server.close();
  await databases.dispose();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
