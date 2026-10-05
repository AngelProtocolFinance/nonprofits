import { apiKey } from "@better-auth/api-key";
import type { Client } from "@libsql/client";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { API_KEY_LETTERS, API_KEY_PREFIX } from "./authorize.ts";
import { libsqlDialect } from "./libsql-dialect.ts";

export const MAX_KEY_NAME_LENGTH = 32;

function log(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  ...args: unknown[]
): void {
  // the origin is derived per request on purpose, so this warns on every new instance
  if (message.includes("Base URL is not set")) return;
  console[level](message, ...args);
}

/** Shared with `auth.generate.ts`, which diffs them against the app migrations; only the database differs. */
export const authOptions = {
  logger: { log },
  plugins: [
    apiKey({
      defaultPrefix: API_KEY_PREFIX,
      defaultKeyLength: API_KEY_LETTERS,
      maximumNameLength: MAX_KEY_NAME_LENGTH,
      // CLI-issued keys never expire; revocation is the only way a key stops working.
      keyExpiration: { defaultExpiresIn: null },
      // the plugin's default is 10 requests/day per key; quotas belong to `authorize` and `quota.ts`
      rateLimit: { enabled: false },
    }),
  ],
} satisfies BetterAuthOptions;

/** better-auth's `database` option over a libSQL client. */
export function authDatabase(client: Client) {
  return {
    dialect: libsqlDialect(client),
    type: "sqlite",
    transaction: false,
  } as const;
}

/**
 * A better-auth instance for one request; never cache it across requests. The
 * key plugin leaves its expired-key sweep running after `createApiKey` and
 * `updateApiKey` return. That query, still in flight when its request ended,
 * has been seen to wedge every later query through the same instance; that it
 * can't on Vercel's Node runtime is unproven. The cost: each instance introspects the app
 * database's tables (its schema check) before its first call, paid per admin
 * request, which is fine for operator-only traffic.
 */
export function createAuth(appDb: Client, secret: string) {
  return betterAuth({
    ...authOptions,
    database: authDatabase(appDb),
    secret,
  });
}

export type Auth = ReturnType<typeof createAuth>;
