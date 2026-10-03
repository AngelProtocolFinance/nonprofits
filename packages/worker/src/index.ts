import { admin } from "./admin.ts";
import { type HandlerError, lookup } from "./handlers.ts";
import { problem } from "./problem.ts";

const ORG_PATH = /^\/v1\/orgs\/([^/]+)$/;

const STATUS = {
  invalid_ein: 400,
  missing_api_key: 401,
  invalid_api_key: 401,
  revoked_api_key: 401,
  not_found: 404,
} as const satisfies Record<HandlerError["code"], number>;

/** A Bearer token, any other `Authorization` value whole (refused as malformed), or null. */
function credentialOf(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return null;
  return /^Bearer +(.*)$/i.exec(authorization)?.[1] ?? authorization;
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/admin/")) return admin(request, env);
    const match = ORG_PATH.exec(pathname);
    if (match?.[1] === undefined) {
      return problem(404, "route_not_found", `No route for ${pathname}.`);
    }
    if (request.method !== "GET") {
      return problem(405, "method_not_allowed", "Use GET.", { allow: "GET" });
    }

    const result = await lookup(match[1], {
      env,
      credential: credentialOf(request),
      now: new Date(),
    });
    if (result.ok) return Response.json(result.value);
    const status = STATUS[result.error.code];
    return problem(
      status,
      result.error.code,
      result.error.message,
      status === 401 ? { "www-authenticate": 'Bearer realm="nonprofits"' } : {},
    );
  },
} satisfies ExportedHandler<Env>;
