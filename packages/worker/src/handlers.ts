import { defaultKeyHasher } from "@better-auth/api-key";
import {
  lookupOrg,
  type OrgLookupError,
  type OrgResponse,
  type OrgSearchError,
  type OrgSearchResponse,
  type Result,
  searchOrgs,
} from "@nonprofits/core";
import { API_KEY_LETTERS, API_KEY_PREFIX } from "./auth.ts";
import { D1OrgReader } from "./d1-org-reader.ts";
import { D1OrgSearcher } from "./d1-org-searcher.ts";
import {
  burstRefusal,
  countMeteredRequest,
  countRequest,
  KEYLESS_LIMITS,
  type Limits,
  limitsOf,
  type QuotaError,
  type Tier,
} from "./quota.ts";
import { isSecretSet } from "./secret.ts";

/** What every transport (REST, MCP) hands a handler. */
export interface HandlerContext {
  env: Env;
  /** null: no credential was sent at all, so the request is keyless. */
  credential: string | null;
  /** The `CF-Connecting-IP` header; a keyless caller's identity. */
  clientIp: string | null;
  now: Date;
}

/** Why a sent credential was refused; each is a 401 on every transport. */
export type AuthError = {
  code: "invalid_api_key" | "revoked_api_key";
  message: string;
};

/** The key store failed mid-check, so there is no verdict on the key: a 503, never a 401. */
export type AuthUnavailable = { code: "auth_unavailable"; message: string };

/** D1 failed a data read: a 503 the caller can retry, never a bare 500. */
export type DataUnavailable = { code: "data_unavailable"; message: string };

/** Every refusal a handler can return; transports map each `code`. */
export type HandlerError =
  | OrgLookupError
  | OrgSearchError
  | AuthError
  | AuthUnavailable
  | QuotaError
  | DataUnavailable;

/**
 * Who a request is counted as: a valid key (`subject` is its id; a whitelisted
 * key has its own limits, set by `keys set-limit`), or with no key a client IP
 * (`subject` is `ip:` and its keyed hash).
 */
export interface Principal {
  subject: string;
  tier: Tier;
  limits: Limits;
}

/**
 * The plugin's `apikey` row for a hashed key, with its limits, read directly:
 * the plugin's `verifyApiKey` writes the row on every call (`lastRequest`,
 * `updatedAt`) and has no option that stops it in database storage.
 * `enabled` is 0 once revoked.
 */
const KEY_SQL = `
SELECT k.id, k.enabled, k.expiresAt, l.daily, l.per_minute AS perMinute
FROM apikey k LEFT JOIN key_limits l ON l.key_id = k.id
WHERE k.key = ?1`;

interface StoredKey {
  id: string;
  enabled: number | null;
  expiresAt: string | null;
  daily: number | null;
  perMinute: number | null;
}

const KEY_FORMAT = new RegExp(
  `^${API_KEY_PREFIX}[A-Za-z]{${API_KEY_LETTERS}}$`,
);

/**
 * The key in an `Authorization: Bearer <key>` header, for every transport.
 * Any other value is sent the wrong way, so it comes back as "", which
 * `authorize` refuses as malformed rather than serving it keyless.
 */
export function bearerCredential(authorization: string | null): string | null {
  if (authorization === null) return null;
  return /^Bearer +(\S+)$/i.exec(authorization)?.[1] ?? "";
}

/** The `WWW-Authenticate` value a key refusal carries; a sent-but-refused key is `invalid_token` (RFC 6750 §3.1). */
export function challenge(error: HandlerError): string | null {
  switch (error.code) {
    case "invalid_api_key":
    case "revoked_api_key":
      return 'Bearer realm="nonprofits", error="invalid_token"';
    default:
      return null;
  }
}

/** Every key refusal ends by saying how to get served without one, and how to get one. */
function refuse(
  code: AuthError["code"],
  reason: string,
): Result<never, AuthError> {
  // a sent key that was refused is routine traffic, logged without key material
  console.info(`api key refused: ${code}`);
  return {
    ok: false,
    error: {
      code,
      message: `${reason} Requests sent without an \`Authorization\` header get a small free tier; for more, ask the operator for a key.`,
    },
  };
}

/** An Error is logged as text: `wrangler dev` stalls when handed the object. */
function logFailure(event: string, cause: unknown) {
  console.error(
    JSON.stringify({
      event,
      cause: cause instanceof Error ? `${cause.name}: ${cause.message}` : cause,
    }),
  );
}

const KEY_CHECK_UNAVAILABLE =
  "The key check is unavailable right now; nothing is wrong with your key. Retry shortly.";
const KEYLESS_UNAVAILABLE =
  "Requests without an API key can't be served right now. Retry later, or send an API key.";

function unavailable(
  cause: unknown,
  message = KEY_CHECK_UNAVAILABLE,
): Result<never, AuthUnavailable> {
  logFailure("auth_unavailable", cause);
  return { ok: false, error: { code: "auth_unavailable", message } };
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** The keyless principal for a client IP, stored only as a keyed hash: IPs are personal data. */
async function keyless(
  clientIp: string | null,
  env: Env,
): Promise<Result<Principal, AuthUnavailable>> {
  if (!isSecretSet(env.IP_HASH_SECRET)) {
    return unavailable(
      "IP_HASH_SECRET is unset or a placeholder: keyless requests refused",
      KEYLESS_UNAVAILABLE,
    );
  }
  // only a local or test request lacks the header: all of them share one subject
  let subject = "ip:unknown";
  if (clientIp !== null) {
    const encode = (text: string) => new TextEncoder().encode(text);
    const key = await crypto.subtle.importKey(
      "raw",
      encode(env.IP_HASH_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    subject = `ip:${hex(await crypto.subtle.sign("HMAC", key, encode(clientIp)))}`;
  }
  return {
    ok: true,
    value: { subject, tier: "anonymous", limits: KEYLESS_LIMITS },
  };
}

/** The guard every transport runs before any quota or data read: a sent key, or none at all. */
export async function authorize(
  credential: string | null,
  clientIp: string | null,
  env: Env,
): Promise<Result<Principal, AuthError | AuthUnavailable>> {
  if (credential === null) return keyless(clientIp, env);
  if (!KEY_FORMAT.test(credential)) {
    return refuse(
      "invalid_api_key",
      `API key is malformed: expected \`${API_KEY_PREFIX}\` followed by ${API_KEY_LETTERS} letters, sent as \`Authorization: Bearer <key>\`.`,
    );
  }
  let stored: StoredKey | undefined;
  try {
    const { results } = await env.DB.prepare(KEY_SQL)
      .bind(await defaultKeyHasher(credential))
      .all<StoredKey>();
    stored = results[0];
  } catch (error) {
    return unavailable(error);
  }
  if (stored === undefined) {
    return refuse(
      "invalid_api_key",
      "API key not recognized: check it was copied whole.",
    );
  }
  // revoking disables the key rather than deleting it, so it can be named here
  if (stored.enabled === 0) {
    return refuse("revoked_api_key", "API key has been revoked.");
  }
  if (stored.expiresAt !== null && Date.parse(stored.expiresAt) <= Date.now()) {
    return refuse("invalid_api_key", "API key has expired.");
  }
  return {
    ok: true,
    value: { subject: stored.id, ...limitsOf(stored.daily, stored.perMinute) },
  };
}

/**
 * Gate, then quota: a refused credential is never counted, and an uncounted
 * request is never served. A metered request meets its Rate Limiting binding
 * before D1: the binding's count can't be taken back, and D1 must not count a
 * request the binding refuses.
 */
async function admit(
  ctx: HandlerContext,
): Promise<Result<Principal, HandlerError>> {
  const { env, now } = ctx;
  const authorized = await authorize(ctx.credential, ctx.clientIp, env);
  if (!authorized.ok) return authorized;
  const { subject, tier, limits } = authorized.value;
  let counted: Result<void, QuotaError>;
  try {
    if (tier === "whitelisted") {
      counted = await countRequest(env.DB, subject, limits, now);
    } else {
      const limiter =
        tier === "anonymous"
          ? env.KEYLESS_BURST_LIMITER
          : env.KEY_BURST_LIMITER;
      const burst = await limiter.limit({ key: subject });
      if (!burst.success) {
        return { ok: false, error: burstRefusal(tier, limits.perMinute) };
      }
      counted = await countMeteredRequest(
        env.DB,
        { subject, tier, daily: limits.daily },
        env.SERVICE_DAILY_LIMIT,
        now,
      );
    }
  } catch (error) {
    return unavailable(
      error,
      tier === "anonymous" ? KEYLESS_UNAVAILABLE : KEY_CHECK_UNAVAILABLE,
    );
  }
  return counted.ok ? authorized : counted;
}

function emit(metrics: { event: string; outcome: string; rowsRead: number }) {
  console.log(JSON.stringify(metrics));
}

/** Runs a core op over D1, turning a thrown D1 error into `data_unavailable`. */
async function readData<T, E extends HandlerError>(
  op: () => Promise<Result<T, E>>,
): Promise<Result<T, E | DataUnavailable>> {
  try {
    return await op();
  } catch (error) {
    logFailure("data_unavailable", error);
    return {
      ok: false,
      error: {
        code: "data_unavailable",
        message:
          "The org data store failed to answer; nothing is wrong with your request. Retry shortly.",
      },
    };
  }
}

export async function lookup(
  ein: string,
  ctx: HandlerContext,
): Promise<Result<OrgResponse, HandlerError>> {
  const admitted = await admit(ctx);
  if (!admitted.ok) return admitted;

  let rowsRead = 0;
  const reader = new D1OrgReader(ctx.env.DB, (rows) => {
    rowsRead += rows;
  });
  const result = await readData(() => lookupOrg(ein, reader));
  emit({
    event: "org_lookup",
    outcome: result.ok ? "ok" : result.error.code,
    rowsRead,
  });
  return result;
}

export async function search(
  input: { query: string; limit?: number | undefined },
  ctx: HandlerContext,
): Promise<Result<OrgSearchResponse, HandlerError>> {
  const admitted = await admit(ctx);
  if (!admitted.ok) return admitted;

  let rowsRead = 0;
  const searcher = new D1OrgSearcher(ctx.env.DB, (rows) => {
    rowsRead += rows;
  });
  const result = await readData(() => searchOrgs(input, searcher));
  emit({
    event: "org_search",
    outcome: result.ok ? "ok" : result.error.code,
    rowsRead,
  });
  return result;
}
