import type { Client } from "@libsql/client";
import { type Context, Hono } from "hono";
import { methodNotAllowed } from "hono/method-not-allowed";
import { adminRoutes } from "./admin.ts";
import { clientRequestOf } from "./authorize.ts";
import { servedDataResolver } from "./data-db.ts";
import {
  type ApiVars,
  type HandlerContext,
  lookup,
  type Service,
  search,
} from "./handlers.ts";
import type { RateLimiter } from "./limiter.ts";
import { logFailure } from "./log.ts";
import { mcpHandlers } from "./mcp.ts";
import { problem } from "./problem.ts";
import { refuse } from "./refusal.ts";
import type { SearchCache } from "./search-cache.ts";

export type { ApiVars } from "./handlers.ts";

/** Everything the app reads that isn't in a request. */
export interface AppDeps {
  /** auth, usage counters and the served-database pointer */
  appDb: Client;
  /** A client on the data database at a pointer's `database_url`. */
  openDataDb: (url: string) => Client;
  /** keyless requests per client per minute */
  keylessBurst: RateLimiter;
  /** default-tier key requests per key per minute */
  keyBurst: RateLimiter;
  /** requests carrying any key, per client per minute, before the key is read */
  keyedRequests: RateLimiter;
  /** keyless HTTP requests to `/mcp` per client per minute, whatever messages each carries */
  keylessMcpRequests: RateLimiter;
  /** searches answered again without ranking, after the caller is authorized and counted */
  searchCache: SearchCache;
  now: () => Date;
  vars: ApiVars;
}

/** Digits only: `Number` would also take `1e1`, `0x10` and ` 5`. NaN is refused by core. */
function limitOf(limit: string | undefined): number | undefined {
  if (limit === undefined) return undefined;
  return /^\d+$/.test(limit) ? Number(limit) : Number.NaN;
}

/** The REST and MCP app over `deps`; each app resolves the served data database on its own. */
export function createApp(deps: AppDeps) {
  const service: Service = {
    appDb: deps.appDb,
    servedData: servedDataResolver(deps.appDb, deps.openDataDb),
    keylessBurst: deps.keylessBurst,
    keyBurst: deps.keyBurst,
    keyedRequests: deps.keyedRequests,
    keylessMcpRequests: deps.keylessMcpRequests,
    searchCache: deps.searchCache,
    vars: deps.vars,
  };
  const contextOf = (c: Context): HandlerContext => ({
    service,
    request: clientRequestOf(c.req.raw),
    now: deps.now(),
  });

  const app = new Hono();
  app.use(
    methodNotAllowed({
      app,
      // `methods` adds HEAD to every GET path, served from the GET handler unasked
      onMethodNotAllowed: (_, methods) =>
        problem(
          405,
          "method_not_allowed",
          `Use ${methods.filter((method) => method !== "HEAD").join(" or ")}.`,
          { allow: methods.join(", ") },
        ),
    }),
  );
  app.notFound((c) =>
    problem(404, "route_not_found", `No route for ${c.req.path}.`),
  );
  app.onError((error) => {
    logFailure("internal_error", error);
    return problem(
      500,
      "internal_error",
      "The request failed on the server. Retry; if it keeps failing, tell the operator.",
    );
  });

  return app
    .get("/v1/orgs/:ein", async (c) => {
      const result = await lookup(c.req.param("ein"), contextOf(c));
      return result.ok ? c.json(result.value, 200) : refuse(c, result.error);
    })
    .get("/v1/search", async (c) => {
      const result = await search(
        {
          query: c.req.query("q") ?? "",
          limit: limitOf(c.req.query("limit")),
        },
        contextOf(c),
      );
      return result.ok ? c.json(result.value, 200) : refuse(c, result.error);
    })
    .post("/mcp", ...mcpHandlers(service, deps.now))
    .route(
      "/admin",
      adminRoutes({ appDb: deps.appDb, vars: deps.vars, now: deps.now }),
    );
}

/** The routes and the bodies and statuses each returns, for a typed client. */
export type AppType = ReturnType<typeof createApp>;
