import type { Result } from "@nonprofits/core";
import { ipAddress } from "@vercel/functions";
import { clientSubject } from "./client.ts";
import { logFailure } from "./log.ts";
import { isSecretSet } from "./secret.ts";

/** What `authorize` reads from a request, by name so no two can be swapped. */
export interface ClientRequest {
  /** The `Authorization` header as sent; null: none was, so the request is keyless. */
  authorization: string | null;
  /**
   * The client's IP from `x-real-ip`, which Vercel sets on every request and
   * overwrites when a client sends its own: a header a client can set
   * would let it mint fresh quota by rotating it.
   */
  clientIp: string | null;
}

/** The client a request is, read from its headers the same way on every transport. */
export function clientRequestOf(request: Request): ClientRequest {
  return {
    authorization: request.headers.get("authorization"),
    clientIp: ipAddress(request) ?? null,
  };
}

/** The request can't be counted, so it isn't served: a 503, never a pass. */
export type AuthUnavailable = { code: "auth_unavailable"; message: string };

export const KEYLESS_UNAVAILABLE =
  "Requests without an API key can't be served right now. Retry later, or send an API key.";

const KEYS_NOT_SERVED =
  "API keys can't be checked here yet, so this refusal says nothing about your key. Send the request without an `Authorization` header to use the free tier.";

export function unavailable(
  cause: unknown,
  message: string,
): Result<never, AuthUnavailable> {
  logFailure("auth_unavailable", cause);
  return { ok: false, error: { code: "auth_unavailable", message } };
}

/** Who a request is counted as: with no key, its client IP as `ip:` and a keyed hash. */
export interface Principal {
  subject: string;
}

/**
 * The guard every transport runs before any quota or data read. A request
 * carrying a key is refused rather than served keyless, where it would spend
 * its IP's quota under limits its sender never asked for.
 */
export async function authorize(
  request: ClientRequest,
  ipHashSecret: string | undefined,
): Promise<Result<Principal, AuthUnavailable>> {
  if (request.authorization !== null) {
    return {
      ok: false,
      error: { code: "auth_unavailable", message: KEYS_NOT_SERVED },
    };
  }
  if (!isSecretSet(ipHashSecret)) {
    return unavailable(
      "IP_HASH_SECRET is unset or a placeholder: requests refused",
      KEYLESS_UNAVAILABLE,
    );
  }
  return {
    ok: true,
    value: { subject: clientSubject(request.clientIp, ipHashSecret) },
  };
}
