import { type HandlerError, lookup } from "./handlers.ts";

const ORG_PATH = /^\/v1\/orgs\/([^/]+)$/;

const STATUS = {
  invalid_ein: 400,
  not_found: 404,
} as const satisfies Record<HandlerError["code"], number>;

const TITLE = {
  400: "Bad Request",
  404: "Not Found",
  405: "Method Not Allowed",
};

/** RFC 9457 problem details; `code` is the stable value clients branch on. */
function problem(
  status: keyof typeof TITLE,
  code: string,
  detail: string,
  headers?: HeadersInit,
): Response {
  return Response.json(
    { type: "about:blank", title: TITLE[status], status, detail, code },
    {
      status,
      headers: { ...headers, "content-type": "application/problem+json" },
    },
  );
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const match = ORG_PATH.exec(pathname);
    if (match?.[1] === undefined) {
      return problem(404, "route_not_found", `No route for ${pathname}.`);
    }
    if (request.method !== "GET") {
      return problem(405, "method_not_allowed", "Use GET.", { allow: "GET" });
    }

    const result = await lookup(match[1], {
      env,
      credential: null,
      now: new Date(),
    });
    return result.ok
      ? Response.json(result.value)
      : problem(
          STATUS[result.error.code],
          result.error.code,
          result.error.message,
        );
  },
} satisfies ExportedHandler<Env>;
