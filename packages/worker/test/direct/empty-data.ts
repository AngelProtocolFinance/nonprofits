import { resetGenerationSql, sealGenerationSql } from "@nonprofits/db";
import { runSql } from "../d1-sql.ts";

/**
 * Serves slot a with no orgs, so an admitted lookup is `not_found`: sealed
 * for build `empty`, the build the pointer starts on.
 */
export async function emptyServedData(env: Env): Promise<void> {
  await runSql(env.DATA_DB_A, resetGenerationSql("a", "empty"));
  await env.DATA_DB_A.prepare(sealGenerationSql("empty")).run();
}
