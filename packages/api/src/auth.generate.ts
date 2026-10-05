import type { Client } from "@libsql/client";
import { appDbFixture } from "@nonprofits/db/fixture";
import type { BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { authDatabase, authOptions } from "./auth.ts";

/**
 * The SQL that brings `appDb` to the tables, columns and indexes better-auth
 * expects under `options`, or "" when it already holds them. better-auth
 * types a date column `date`, which a STRICT table refuses; the app stores
 * dates as ISO-8601 text, so each comes out as `text`.
 */
export async function pendingAuthMigration(
  appDb: Client,
  options: BetterAuthOptions = authOptions,
): Promise<string> {
  const plan = await getMigrations({
    ...options,
    database: authDatabase(appDb),
    logger: {
      log(level, message, ...args) {
        // every date column warns so: the text this function maps them to
        if (!/Expected date but got TEXT\.$/.test(message)) {
          console[level](message, ...args);
        }
      },
    },
  });
  const pending =
    plan.toBeCreated.length +
    plan.toBeAdded.length +
    plan.toBeAddedIndexes.length;
  if (pending === 0) return "";
  const sql = await plan.compileMigrations();
  return `${sql.replaceAll(/("[^"]+") date\b/g, "$1 text")}\n`;
}

// `pnpm --filter @nonprofits/api auth:generate`: diffs better-auth's schema
// against a fresh database holding every app migration, and prints the SQL
// for the next migration in `packages/db/migrations/app/`, if one is needed.
if (import.meta.main) {
  const appDb = await appDbFixture();
  try {
    const sql = await pendingAuthMigration(appDb.client);
    if (sql === "") {
      console.error("The app migrations hold better-auth's whole schema.");
    } else {
      process.stdout.write(sql);
    }
  } finally {
    await appDb.dispose();
  }
}
