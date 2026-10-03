import type { Result } from "@nonprofits/core";
import { admin } from "./admin.ts";
import {
  bearerCredential,
  challenge,
  type HandlerContext,
  type HandlerError,
  lookup,
  search,
} from "./handlers.ts";
import { problem } from "./problem.ts";

const ORG_PATH = /^\/v1\/orgs\/([^/]+)$/;
const SEARCH_PATH = "/v1/search";

const STATUS = {
  invalid_ein: 400,
  invalid_query: 400,
  invalid_limit: 400,
  missing_api_key: 401,
  invalid_api_key: 401,
  revoked_api_key: 401,
  not_found: 404,
  auth_unavailable: 503,
  data_unavailable: 503,
} as const satisfies Record<HandlerError["code"], number>;

/** Digits only: `Number` would also take `1e1`, `0x10` and ` 5`. NaN is refused by core. */
function limitOf(url: URL): number | undefined {
  const limit = url.searchParams.get("limit");
  if (limit === null) return undefined;
  return /^\d+$/.test(limit) ? Number(limit) : Number.NaN;
}

function respond(result: Result<unknown, HandlerError>): Response {
  if (result.ok) return Response.json(result.value);
  const { error } = result;
  const wwwAuthenticate = challenge(error);
  return problem(
    STATUS[error.code],
    error.code,
    error.message,
    wwwAuthenticate === null ? {} : { "www-authenticate": wwwAuthenticate },
  );
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname.startsWith("/admin/")) return admin(request, env);
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
} satisfies ExportedHandler<Env>;
