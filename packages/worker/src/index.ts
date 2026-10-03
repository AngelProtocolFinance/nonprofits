import type { Result } from "@nonprofits/core";
import { admin } from "./admin.ts";
import {
  bearerCredential,
  type HandlerContext,
  type HandlerError,
  lookup,
  search,
} from "./handlers.ts";
import { mcp } from "./mcp.ts";
import { problem } from "./problem.ts";
import { pruneUsage } from "./quota.ts";
import { refusalResponse } from "./refusal.ts";

const ORG_PATH = /^\/v1\/orgs\/([^/]+)$/;
const SEARCH_PATH = "/v1/search";

/** Digits only: `Number` would also take `1e1`, `0x10` and ` 5`. NaN is refused by core. */
function limitOf(url: URL): number | undefined {
  const limit = url.searchParams.get("limit");
  if (limit === null) return undefined;
  return /^\d+$/.test(limit) ? Number(limit) : Number.NaN;
}

function respond(result: Result<unknown, HandlerError>): Response {
  return result.ok
    ? Response.json(result.value)
    : refusalResponse(result.error);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname.startsWith("/admin/")) return admin(request, env);
    if (pathname === "/mcp") return mcp(request, env);
    const ein = ORG_PATH.exec(pathname)?.[1];
    if (ein === undefined && pathname !== SEARCH_PATH) {
      return problem(404, "route_not_found", `No route for ${pathname}.`);
    }
    if (request.method !== "GET") {
      return problem(405, "method_not_allowed", "Use GET.", { allow: "GET" });
    }

    const ctx: HandlerContext = {
      env,
      credential: bearerCredential(request.headers.get("authorization")),
      clientIp: request.headers.get("cf-connecting-ip"),
      cfWorker: request.headers.get("cf-worker"),
      now: new Date(),
    };
    if (ein !== undefined) return respond(await lookup(ein, ctx));
    return respond(
      await search(
        { query: url.searchParams.get("q") ?? "", limit: limitOf(url) },
        ctx,
      ),
    );
  },

  async scheduled(controller, env): Promise<void> {
    await pruneUsage(env.APP_DB, new Date(controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
