import { admin } from "./admin.ts";
import {
  bearerCredential,
  challenge,
  type HandlerError,
  lookup,
} from "./handlers.ts";
import { problem } from "./problem.ts";

const ORG_PATH = /^\/v1\/orgs\/([^/]+)$/;

const STATUS = {
  invalid_ein: 400,
  missing_api_key: 401,
  invalid_api_key: 401,
  revoked_api_key: 401,
  not_found: 404,
  auth_unavailable: 503,
} as const satisfies Record<HandlerError["code"], number>;

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
      credential: bearerCredential(request.headers.get("authorization")),
      now: new Date(),
    });
    if (result.ok) return Response.json(result.value);
    const { error } = result;
    const wwwAuthenticate = challenge(error);
    return problem(
      STATUS[error.code],
      error.code,
      error.message,
      wwwAuthenticate === null ? {} : { "www-authenticate": wwwAuthenticate },
    );
  },
} satisfies ExportedHandler<Env>;
