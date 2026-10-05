import type { Client } from "@libsql/client";
import { appDbFixture } from "@nonprofits/db/fixture";
import type { BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { authDatabase, authOptions } from "./auth.ts";

/** What `appDb` lacks for better-auth under some options, and what it holds that better-auth can't write. */
export interface AuthMigrationPlan {
  /** the next app migration, or "" when every table, column and index is there */
  sql: string;
  /** one sentence per required column better-auth never writes: each fails every insert into its table */
  schemaProblems: string[];
}

// The app's tables are STRICT, which accepts only INTEGER, REAL, TEXT, BLOB
// and ANY: better-auth's `date` is stored as ISO-8601 text, and its `bigint`
// is SQLite's 64-bit integer.
const STRICT_TYPES: [RegExp, string][] = [
  [/("[^"]+") date\b/g, "$1 text"],
  [/("[^"]+") bigint\b/g, "$1 integer"],
];

function asAppStatement(statement: string): string {
  const typed = STRICT_TYPES.reduce(
    (sql, [type, strict]) => sql.replaceAll(type, strict),
    statement,
  );
  return /^create table /i.test(typed) ? `${typed} strict` : typed;
}

/**
 * The plan that brings `appDb` to the schema better-auth expects under
 * `options`, its SQL written the way the app's migrations are: STRICT tables
 * with STRICT column types.
 */
export async function pendingAuthMigration(
  appDb: Client,
  options: BetterAuthOptions = authOptions,
): Promise<AuthMigrationPlan> {
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
  const { schemaProblems } = plan;
  if (pending === 0) return { sql: "", schemaProblems };
  // compileMigrations joins its statements so, and ends the last with ";"
  const statements = (await plan.compileMigrations())
    .replace(/;$/, "")
    .split(";\n\n");
  return {
    sql: `${statements.map(asAppStatement).join(";\n\n")};\n`,
    schemaProblems,
  };
}

// `pnpm --filter @nonprofits/api auth:generate`: diffs better-auth's schema
// against a fresh database holding every app migration, and prints the SQL
// for the next migration in `packages/db/migrations/app/`, if one is needed;
// exits 1 naming each column the migrations require that better-auth never writes.
if (import.meta.main) {
  const appDb = await appDbFixture();
  try {
    const { sql, schemaProblems } = await pendingAuthMigration(appDb.client);
    for (const problem of schemaProblems) console.error(problem);
    if (schemaProblems.length > 0) process.exitCode = 1;
    if (sql !== "") {
      process.stdout.write(sql);
    } else if (schemaProblems.length === 0) {
      console.error("The app migrations hold better-auth's whole schema.");
    }
  } finally {
    await appDb.dispose();
  }
}
