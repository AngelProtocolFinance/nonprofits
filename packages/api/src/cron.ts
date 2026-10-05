import type { Client } from "@libsql/client";
import { Hono } from "hono";
import { type FreshnessDeps, guardFreshness } from "./freshness.ts";
import { problem } from "./problem.ts";
import { utcDay } from "./quota.ts";
import { isBearerOf, isSecretSet, MIN_SECRET_LENGTH } from "./secret.ts";

const USAGE_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Deletes usage rows more than `USAGE_RETENTION_DAYS` days before `at`'s UTC day. */
async function pruneUsage(appDb: Client, at: Date): Promise<void> {
  const cutoff = utcDay(new Date(at.getTime() - USAGE_RETENTION_DAYS * DAY_MS));
  await appDb.execute({
    sql: "DELETE FROM key_usage WHERE day < ?1",
    args: [cutoff],
  });
}

export interface CronDeps extends FreshnessDeps {
  now: () => Date;
}

/** The routes Vercel's cron calls, each with `Authorization: Bearer $CRON_SECRET`. */
export function cronRoutes(deps: CronDeps) {
  return new Hono()
    .use(async (c, next) => {
      const secret = deps.vars.CRON_SECRET;
      if (!isSecretSet(secret)) {
        return problem(
          503,
          "cron_disabled",
          `The cron is off: set the CRON_SECRET secret to at least ${MIN_SECRET_LENGTH} random characters.`,
        );
      }
      if (!isBearerOf(c.req.header("authorization"), secret)) {
        return problem(
          401,
          "cron_unauthorized",
          "Cron routes need `Authorization: Bearer <CRON_SECRET>`.",
          { "www-authenticate": 'Bearer realm="nonprofits-cron"' },
        );
      }
      await next();
    })
    .get("/daily", async (c) => {
      try {
        await pruneUsage(deps.appDb, deps.now());
      } finally {
        await guardFreshness(deps);
      }
      return c.body(null, 204);
    });
}
