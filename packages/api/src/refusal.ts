import type { HandlerError } from "./handlers.ts";
import {
  PROBLEM_CONTENT_TYPE,
  type ProblemStatus,
  problemBody,
} from "./problem.ts";

const STATUS = {
  invalid_ein: 400,
  invalid_query: 400,
  invalid_limit: 400,
  not_found: 404,
  invalid_api_key: 401,
  revoked_api_key: 401,
  daily_quota_exceeded: 429,
  per_minute_limit_exceeded: 429,
  service_daily_limit_reached: 429,
  auth_unavailable: 503,
  data_unavailable: 503,
} as const satisfies Record<HandlerError["code"], ProblemStatus>;

/** What a refused key's 401 carries: a sent-but-refused key is `invalid_token` (RFC 6750 §3.1). */
const CHALLENGE = 'Bearer realm="nonprofits", error="invalid_token"';

/** A handler refusal as an HTTP problem: its body, status and headers, `WWW-Authenticate` on a 401, `Retry-After` on a 429. */
export function refusal(error: HandlerError) {
  const status = STATUS[error.code];
  // `Content-Type` as Hono spells it, or `c.json` sends its own beside this one
  const headers: Record<string, string> = {
    "Content-Type": PROBLEM_CONTENT_TYPE,
  };
  if (status === 401) headers["WWW-Authenticate"] = CHALLENGE;
  if ("retryAfterSeconds" in error) {
    headers["Retry-After"] = String(error.retryAfterSeconds);
  }
  return {
    body: problemBody(status, error.code, error.message),
    status,
    headers,
  };
}
