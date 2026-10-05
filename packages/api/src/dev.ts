import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { switchServedDatabase } from "@nonprofits/db";
import { appDbFixture, dataDbFixture } from "@nonprofits/db/fixture";
import { dataDbClient } from "@nonprofits/db/node";
import { createApp } from "./app.ts";
import { memoryRateLimiter } from "./limiter.ts";
import {
  BURST_PERIOD_SECONDS,
  DEFAULT_LIMITS,
  KEYED_REQUESTS_PER_MINUTE,
  KEYLESS_LIMITS,
  KEYLESS_MCP_REQUESTS_PER_MINUTE,
} from "./quota.ts";

// Serves the api on localhost over fresh fixture databases in a temp directory,
// deleted on exit: the app database, migrated, pointing at a data database
// holding `packages/db/fixtures/seed.sql`. The admin routes stay off until
// `packages/api/.env.local` (ignored; the cli's `keys` script reads it too) sets
// ADMIN_TOKEN and BETTER_AUTH_SECRET, each from `openssl rand -base64 32`.
const appDb = await appDbFixture();
const dataDb = await dataDbFixture("fixture");
await switchServedDatabase(appDb.client, {
  expected: null,
  to: { name: "nonprofits-fixture", url: dataDb.url },
  buildId: "fixture",
});

const now = () => new Date();
const perMinute = (limit: number) =>
  memoryRateLimiter({ limit, periodSeconds: BURST_PERIOD_SECONDS, now });
const app = createApp({
  appDb: appDb.client,
  openDataDb: (url) => dataDbClient(url, process.env),
  keylessBurst: perMinute(KEYLESS_LIMITS.perMinute),
  keyBurst: perMinute(DEFAULT_LIMITS.perMinute),
  keyedRequests: perMinute(KEYED_REQUESTS_PER_MINUTE),
  keylessMcpRequests: perMinute(KEYLESS_MCP_REQUESTS_PER_MINUTE),
  now,
  vars: {
    // a fresh key per run: the usage rows it hashes are deleted with the run
    IP_HASH_SECRET:
      process.env.IP_HASH_SECRET ?? randomBytes(32).toString("base64url"),
    SERVICE_KEYLESS_DAILY_LIMIT: process.env.SERVICE_KEYLESS_DAILY_LIMIT,
    SERVICE_KEY_DAILY_LIMIT: process.env.SERVICE_KEY_DAILY_LIMIT,
    ADMIN_TOKEN: process.env.ADMIN_TOKEN,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  },
});

const port = Number(process.env.PORT ?? 8787);
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`api on http://localhost:${port} over the fixture databases`);
});

async function shutdown() {
  server.close();
  await appDb.dispose();
  await dataDb.dispose();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
