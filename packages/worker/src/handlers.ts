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
import { clientSubject } from "./client.ts";
import { D1OrgReader } from "./d1-org-reader.ts";
import { D1OrgSearcher } from "./d1-org-searcher.ts";
import {
  burstRefusal,
  countMeteredRequest,
  countRequest,
  KEYLESS_LIMITS,
  keyedRequestRefusal,
  type Limits,
  limitsOf,
  type QuotaError,
  type Tier,
} from "./quota.ts";
import { isSecretSet } from "./secret.ts";

/** What every transport (REST, MCP) hands a handler. */
export interface HandlerContext extends ClientRequest {
  env: Env;
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

/** What `authorize` reads from a request, by name so no two can be swapped. */
export interface ClientRequest {
  /** null: no credential was sent at all, so the request is keyless. */
  credential: string | null;
  /**
   * The request's `CF-Connecting-IP` header, which identifies the client.
   * Every transport (MCP included) passes the real header, never a constant:
   * a shared value would put every client in one bucket.
   */
  clientIp: string | null;
  /** The `CF-Worker` header: the zone of the Worker that sent this request, if one did. */
  cfWorker?: string | null;
}

/** The request's client as a usage subject, or unavailable while the secret keying its hash is unset. */
async function subjectOf(
  request: ClientRequest,
  unavailableMessage: string,
  env: Env,
): Promise<Result<string, AuthUnavailable>> {
  if (!isSecretSet(env.IP_HASH_SECRET)) {
    return unavailable(
      "IP_HASH_SECRET is unset or a placeholder: requests refused",
      unavailableMessage,
    );
  }
  const subject = await clientSubject(
    { ip: request.clientIp, worker: request.cfWorker ?? null },
    env.IP_HASH_SECRET,
  );
  return { ok: true, value: subject };
}

/**
 * Caps requests carrying any key per client before the key is read, so a
 * stream of bad keys can't turn into one D1 read each.
 */
async function limitKeyedRequests(
  request: ClientRequest,
  env: Env,
): Promise<Result<void, QuotaError | AuthUnavailable>> {
  const client = await subjectOf(request, KEY_CHECK_UNAVAILABLE, env);
  if (!client.ok) return client;
  try {
    const { success } = await env.KEYED_REQUEST_LIMITER.limit({
      key: client.value,
    });
    return success
      ? { ok: true, value: undefined }
      : { ok: false, error: keyedRequestRefusal() };
  } catch (error) {
    return unavailable(error);
  }
}

/** The guard every transport runs before any quota or data read: a sent key, or none at all. */
export async function authorize(
  request: ClientRequest,
  env: Env,
): Promise<Result<Principal, AuthError | AuthUnavailable | QuotaError>> {
  const { credential } = request;
  if (credential === null) {
    const client = await subjectOf(request, KEYLESS_UNAVAILABLE, env);
    if (!client.ok) return client;
    return {
      ok: true,
      value: {
        subject: client.value,
        tier: "anonymous",
        limits: KEYLESS_LIMITS,
      },
    };
  }
  const limited = await limitKeyedRequests(request, env);
  if (!limited.ok) return limited;
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
 * A limit var as a count, or null when it is none. A var set as text arrives
 * as a string, and SQLite sorts every number below every string, so a limit
 * bound as text would never refuse.
 */
function countOf(value: unknown): number | null {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
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
  const authorized = await authorize(ctx, env);
  if (!authorized.ok) return authorized;
  const { subject, tier, limits } = authorized.value;
  let counted: Result<void, QuotaError>;
  try {
    if (tier === "whitelisted") {
      counted = await countRequest(env.DB, subject, limits, now);
    } else {
      const serviceDaily = countOf(
        tier === "anonymous"
          ? env.SERVICE_KEYLESS_DAILY_LIMIT
          : env.SERVICE_KEY_DAILY_LIMIT,
      );
      if (serviceDaily === null) {
        return unavailable(
          `service daily limit for ${tier} is not a positive integer`,
          tier === "anonymous" ? KEYLESS_UNAVAILABLE : KEY_CHECK_UNAVAILABLE,
        );
      }
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
        serviceDaily,
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
