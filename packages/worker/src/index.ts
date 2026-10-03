import { lookupOrg, type OrgLookupError } from "@irs-lookup/core";
import { D1OrgReader } from "./d1-org-reader.ts";

const ORG_PATH = /^\/v1\/orgs\/([^/]+)$/;

const STATUS: Record<OrgLookupError["code"], 400 | 404> = {
  invalid_ein: 400,
  not_found: 404,
};

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
      return problem(404, "not_found", `No route for ${pathname}.`);
    }
    if (request.method !== "GET") {
      return problem(405, "method_not_allowed", "Use GET.", { allow: "GET" });
    }

    const reader = new D1OrgReader(env.DB);
    const result = await lookupOrg(match[1], reader);
    const response = result.ok
      ? Response.json(result.org)
      : problem(
          STATUS[result.error.code],
          result.error.code,
          result.error.message,
        );
    console.log(
      JSON.stringify({
        event: "org_lookup",
        status: response.status,
        rowsRead: reader.rowsRead,
      }),
    );
    return response;
  },
} satisfies ExportedHandler<Env>;
