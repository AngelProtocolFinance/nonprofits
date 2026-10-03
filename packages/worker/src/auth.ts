import { apiKey } from "@better-auth/api-key";
import { type BetterAuthOptions, betterAuth } from "better-auth";

/** Every issued key is this prefix plus `API_KEY_LETTERS` ASCII letters. */
export const API_KEY_PREFIX = "npk_";
export const API_KEY_LETTERS = 64;
export const MAX_KEY_NAME_LENGTH = 32;

/** better-auth's log lines, as the Worker wants them in its logs. */
function log(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  ...args: unknown[]
): void {
  // the origin is derived per request on purpose, so this warns on every cold start
  if (message.includes("Base URL is not set")) return;
  // errors as text: `wrangler dev`'s console relay stalls a request for minutes on an error object
  console[level](
    message,
    ...args.map((arg) =>
      arg instanceof Error ? `${arg.name}: ${arg.message}` : arg,
    ),
  );
}

/** Shared with `auth.generate.ts`, which feeds `pnpm auth:generate`; only the database differs. */
export const authOptions = {
  logger: { log },
  plugins: [
    apiKey({
      defaultPrefix: API_KEY_PREFIX,
      defaultKeyLength: API_KEY_LETTERS,
      maximumNameLength: MAX_KEY_NAME_LENGTH,
      // CLI-issued keys never expire; revocation is the only way a key stops working.
      keyExpiration: { defaultExpiresIn: null },
      // the plugin's default is 10 requests/day per key; quotas belong to the handler guard
      rateLimit: { enabled: false },
    }),
  ],
} satisfies BetterAuthOptions;

/**
 * A better-auth instance for one request; never cache it across requests. The
 * key plugin leaves its expired-key sweep running after `updateApiKey` returns,
 * and a query still in flight when its request ends wedges every later query
 * through the same instance. The cost: each new instance introspects every D1
 * table (pragma_table_info) before its first call, paid per admin request,
 * which is fine for operator-only traffic.
 */
export function createAuth(env: Env) {
  return betterAuth({
    ...authOptions,
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
  });
}

export type Auth = ReturnType<typeof createAuth>;
