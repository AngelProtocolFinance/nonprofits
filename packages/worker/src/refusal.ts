import { challenge, type HandlerError } from "./handlers.ts";
import { type ProblemStatus, problem, problemBody } from "./problem.ts";

const STATUS = {
  invalid_ein: 400,
  invalid_query: 400,
  invalid_limit: 400,
  invalid_api_key: 401,
  revoked_api_key: 401,
  not_found: 404,
  daily_quota_exceeded: 429,
  per_minute_limit_exceeded: 429,
  service_daily_limit_reached: 429,
  auth_unavailable: 503,
  data_unavailable: 503,
} as const satisfies Record<HandlerError["code"], ProblemStatus>;

/** A handler refusal as an HTTP problem response, with its `WWW-Authenticate` or `Retry-After`. */
export function refusalResponse(error: HandlerError): Response {
  const headers: Record<string, string> = {};
  const wwwAuthenticate = challenge(error);
  if (wwwAuthenticate !== null) headers["www-authenticate"] = wwwAuthenticate;
  if ("retryAfterSeconds" in error) {
    headers["retry-after"] = String(error.retryAfterSeconds);
  }
  return problem(STATUS[error.code], error.code, error.message, headers);
}

/** A handler refusal as the problem body REST answers, plus the `Retry-After` seconds a 429 carries as a header there. */
export function refusalBody(error: HandlerError) {
  const body = problemBody(STATUS[error.code], error.code, error.message);
  return "retryAfterSeconds" in error
    ? { ...body, retryAfterSeconds: error.retryAfterSeconds }
    : body;
}
