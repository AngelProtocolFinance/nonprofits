import { apiKey } from "@better-auth/api-key";
import { type BetterAuthOptions, betterAuth } from "better-auth";

/** Every issued key is this prefix plus 64 ASCII letters. */
export const API_KEY_PREFIX = "npk_";

/** Shared with `auth.generate.ts`, which feeds `pnpm auth:generate`; only the database differs. */
export const authOptions = {
  logger: {
    // errors as text: `wrangler dev`'s console relay stalls a request for minutes on the plugin's APIError
    log: (level, message, ...args) =>
      console[level](
        message,
        ...args.map((arg) =>
          arg instanceof Error ? `${arg.name}: ${arg.message}` : arg,
        ),
      ),
  },
  plugins: [
    apiKey({
      defaultPrefix: API_KEY_PREFIX,
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

// one instance per isolate: building one validates the schema against live D1
const instances = new WeakMap<Env, Auth>();

export function getAuth(env: Env): Auth {
  let auth = instances.get(env);
  if (auth === undefined) {
    auth = createAuth(env);
    instances.set(env, auth);
  }
  return auth;
}
