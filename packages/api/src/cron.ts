import { Hono } from "hono";
import { type FreshnessDeps, guardFreshness } from "./freshness.ts";
import { problem } from "./problem.ts";
import { pruneUsage } from "./quota.ts";
import { isBearerOf, isSecretSet, MIN_SECRET_LENGTH } from "./secret.ts";

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
