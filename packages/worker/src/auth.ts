import { apiKey } from "@better-auth/api-key";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { isAPIError } from "better-auth/api";

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
  const [cause] = args;
  // a refused key is routine traffic; a storage failure logged here stays an error
  if (message.startsWith("Failed to validate API key") && isAPIError(cause)) {
    console.info(`api key refused: ${cause.body?.code}`);
    return;
  }
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

function createAuth(env: Env) {
  return betterAuth({
    ...authOptions,
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
  });
}

type Auth = ReturnType<typeof createAuth>;

// one instance per isolate: each new one introspects every D1 table (pragma_table_info) before its first call
const instances = new WeakMap<Env, Auth>();

export function getAuth(env: Env): Auth {
  let auth = instances.get(env);
  if (auth === undefined) {
    auth = createAuth(env);
    instances.set(env, auth);
  }
  return auth;
}
