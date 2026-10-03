import { resetGenerationSql } from "@nonprofits/db";
import { runSql } from "../d1-sql.ts";

/** Resets slot a, the one the pointer starts on, to a generation with no orgs: an admitted lookup is then `not_found`. */
export async function emptyServedData(env: Env): Promise<void> {
  await runSql(env.DATA_DB_A, resetGenerationSql("a", "empty"));
}
