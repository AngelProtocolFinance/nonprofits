const TITLE = {
  400: "Bad Request",
  401: "Unauthorized",
  404: "Not Found",
  405: "Method Not Allowed",
  413: "Content Too Large",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

export type ProblemStatus = keyof typeof TITLE;

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** RFC 9457 problem details; `code` is the stable value clients branch on. */
export function problemBody(
  status: ProblemStatus,
  code: string,
  detail: string,
) {
  return { type: "about:blank", title: TITLE[status], status, detail, code };
}

export function problem(
  status: ProblemStatus,
  code: string,
  detail: string,
  headers?: Record<string, string>,
): Response {
  return Response.json(problemBody(status, code, detail), {
    status,
    headers: { ...headers, "content-type": PROBLEM_CONTENT_TYPE },
  });
}
