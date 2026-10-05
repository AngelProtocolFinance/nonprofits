import {
  type AppDbEnv,
  appDbClient,
  type DataDbEnv,
  dataDbClient,
} from "@nonprofits/db/node";
import type { ApiVars, AppDeps } from "./app.ts";
import { firewallLimiters } from "./firewall-limiter.ts";
import { vercelSearchCache } from "./search-cache.ts";
import { isSecretSet, PLACEHOLDER_PREFIX } from "./secret.ts";

/**
 * What a deployment needs of a var: `secret` is required and held to
 * `isSecretSet`, `required` must be set to something other than a
 * placeholder, and `optional` falls back to the code's default when unset.
 */
type Need = "secret" | "required" | "optional";

const APP_VARS = {
  IP_HASH_SECRET: "secret",
  BETTER_AUTH_SECRET: "secret",
  ADMIN_TOKEN: "secret",
  CRON_SECRET: "secret",
  GITHUB_DISPATCH_TOKEN: "optional",
  GITHUB_REPO: "optional",
  STALE_AFTER_DAYS: "optional",
  REDISPATCH_AFTER_HOURS: "optional",
  SERVICE_KEYLESS_DAILY_LIMIT: "optional",
  SERVICE_KEY_DAILY_LIMIT: "optional",
} as const satisfies Record<keyof ApiVars, Need>;

const DB_VARS = {
  TURSO_APP_DB_URL: "required",
  TURSO_APP_DB_TOKEN: "secret",
  TURSO_DATA_DB_TOKEN: "secret",
} as const satisfies Record<keyof AppDbEnv | keyof DataDbEnv, Need>;

/** Read by `@vercel/firewall` itself: salts the rate-limit keys it sends to the Firewall. */
const SDK_VARS = { RATE_LIMIT_SECRET: "optional" } as const;

/**
 * Every var an operator sets for the deployed app; `.env.example` lists the
 * same names. Vars the platform provides (`VERCEL_GIT_*`, `NODE_ENV`,
 * `RUNTIME_CACHE_*`, `@vercel/firewall`'s own) are left out on purpose.
 */
export const PRODUCTION_ENV: Readonly<Record<string, Need>> = {
  ...APP_VARS,
  ...DB_VARS,
  ...SDK_VARS,
};

export type Env = Readonly<Record<string, string | undefined>>;

/** An empty value reads as unset: a dashboard or an env file can hold one. */
function valueOf(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === "" ? undefined : value;
}

function meets(need: Need, value: string | undefined): boolean {
  switch (need) {
    case "secret":
      return isSecretSet(value);
    case "required":
      return value !== undefined && !value.startsWith(PLACEHOLDER_PREFIX);
    case "optional":
      return true;
  }
}

/** The vars `env` leaves unset, or set to a placeholder or a guessable secret, that the app can't serve without. */
export function missingEnv(env: Env): string[] {
  return Object.entries(PRODUCTION_ENV)
    .filter(([name, need]) => !meets(need, valueOf(env, name)))
    .map(([name]) => name);
}

/** `owner/repo` of the GitHub repository Vercel built this deployment from, if it was. */
function deployedRepo(env: Env): string | undefined {
  const owner = valueOf(env, "VERCEL_GIT_REPO_OWNER");
  const slug = valueOf(env, "VERCEL_GIT_REPO_SLUG");
  return env.VERCEL_GIT_PROVIDER === "github" && owner && slug
    ? `${owner}/${slug}`
    : undefined;
}

function varsOf(env: Env): ApiVars {
  const vars: ApiVars = {};
  for (const name of Object.keys(APP_VARS) as (keyof ApiVars)[]) {
    vars[name] = valueOf(env, name);
  }
  // a fork deployed from its own repository dispatches its own import workflow
  vars.GITHUB_REPO ??= deployedRepo(env);
  return vars;
}

/** The app's deps on Vercel, from an `env` that `missingEnv` passes. */
export function productionDeps(env: Env): AppDeps {
  const dbEnv = {
    TURSO_APP_DB_URL: valueOf(env, "TURSO_APP_DB_URL"),
    TURSO_APP_DB_TOKEN: valueOf(env, "TURSO_APP_DB_TOKEN"),
    TURSO_DATA_DB_TOKEN: valueOf(env, "TURSO_DATA_DB_TOKEN"),
  };
  return {
    appDb: appDbClient(dbEnv),
    openDataDb: (url) => dataDbClient(url, dbEnv),
    ...firewallLimiters(),
    searchCache: vercelSearchCache(),
    now: () => new Date(),
    fetch,
    vars: varsOf(env),
  };
}
