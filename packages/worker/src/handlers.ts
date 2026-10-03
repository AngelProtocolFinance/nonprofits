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
import { READ_ACTIVE_SLOT_SQL } from "@nonprofits/db";
import { API_KEY_LETTERS, API_KEY_PREFIX } from "./auth.ts";
import { clientSubject } from "./client.ts";
import { D1OrgReader } from "./d1-org-reader.ts";
import { activeDataDb } from "./data-db.ts";
import { logFailure } from "./log.ts";
import {
  burstRefusal,
  countMeteredRequest,
  countRequest,
  KEYLESS_LIMITS,
  keyedRequestRefusal,
  keylessMcpRefusal,
  type Limits,
  limitsOf,
  type QuotaError,
  type Tier,
} from "./quota.ts";
import { cachedSearch } from "./search-cache.ts";
import { isSecretSet } from "./secret.ts";

/** What a transport hands a handler that authorizes the request itself (REST). */
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
  /** The `CF-Worker` header as sent: `clientSubject` trusts it only from Cloudflare's cross-zone Worker address. */
  cfWorker: string | null;
}

/** The client a request is, read from its headers the same way on every transport. */
export function clientRequestOf(request: Request): ClientRequest {
  const { headers } = request;
  return {
    credential: bearerCredential(headers.get("authorization")),
    clientIp: headers.get("cf-connecting-ip"),
    cfWorker: headers.get("cf-worker"),
  };
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
    { ip: request.clientIp, worker: request.cfWorker },
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
    const { results } = await env.APP_DB.prepare(KEY_SQL)
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
 * Caps a keyless client's HTTP requests to `/mcp` per minute, whatever
 * messages each carries: handshakes and tool listings aren't metered, and
 * nothing else bounds them. A keyed client's are capped before its key is read
 * (`limitKeyedRequests`).
 */
export async function limitKeylessMcpRequests(
  principal: Principal,
  env: Env,
): Promise<Result<void, QuotaError | AuthUnavailable>> {
  if (principal.tier !== "anonymous") return { ok: true, value: undefined };
  try {
    const { success } = await env.KEYLESS_MCP_LIMITER.limit({
      key: principal.subject,
    });
    return success
      ? { ok: true, value: undefined }
      : { ok: false, error: keylessMcpRefusal() };
  } catch (error) {
    return unavailable(error, KEYLESS_UNAVAILABLE);
  }
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
 * A request `authorize` accepted: who each of its calls is counted as. MCP
 * authorizes once per HTTP request and runs its tool calls as this.
 */
export interface Caller {
  env: Env;
  now: Date;
  principal: Principal;
}

/**
 * Counts one call against the caller's quota; an uncounted call is never
 * served. A metered request meets its Rate Limiting binding before D1: the
 * binding's count can't be taken back, and D1 must not count a request the
 * binding refuses.
 */
async function meter(caller: Caller): Promise<Result<void, HandlerError>> {
  const { env, now } = caller;
  const { subject, tier, limits } = caller.principal;
  let counted: Result<void, QuotaError>;
  try {
    if (tier === "whitelisted") {
      counted = await countRequest(env.APP_DB, subject, limits, now);
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
        env.APP_DB,
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
  return counted;
}

/** The caller a request is, before any quota is read: a refused credential is never counted. */
async function authorizeAs(
  ctx: HandlerContext,
): Promise<Result<Caller, HandlerError>> {
  const authorized = await authorize(ctx, ctx.env);
  if (!authorized.ok) return authorized;
  return {
    ok: true,
    value: { env: ctx.env, now: ctx.now, principal: authorized.value },
  };
}

function emit(metrics: {
  event: string;
  outcome: string;
  rowsRead: number;
  cached?: boolean;
}) {
  console.log(JSON.stringify(metrics));
}

const DATA_FAILED: DataUnavailable = {
  code: "data_unavailable",
  message:
    "The org data store failed to answer; nothing is wrong with your request. Retry shortly.",
};

const DATA_NOT_LOADED: DataUnavailable = {
  code: "data_unavailable",
  message:
    "No org data is loaded yet: the service is waiting for its first IRS import. Nothing is wrong with your request, and it wasn't counted.",
};

/** The pointer's `build_id` until the first import flips it (`0003_data_generation.sql`). */
const NEVER_BUILT = "empty";

/** Why no data DB could be served: never loaded, or a failure to retry past. */
async function unservable(env: Env): Promise<DataUnavailable> {
  try {
    const pointer = await env.APP_DB.prepare(READ_ACTIVE_SLOT_SQL).first<{
      build_id: string;
    }>();
    return pointer?.build_id === NEVER_BUILT ? DATA_NOT_LOADED : DATA_FAILED;
  } catch {
    return DATA_FAILED;
  }
}

/** Ends a core op from inside its reader, with a refusal the op can't return itself. */
class Refused extends Error {
  constructor(readonly refusal: HandlerError) {
    super(refusal.code);
  }
}

/**
 * The served data DB, for a call core has validated: resolved, then the call
 * counted. Invalid input never gets here, and a call no data DB can answer is
 * refused before it is counted.
 */
async function admit(caller: Caller): Promise<D1Database> {
  let db: D1Database;
  try {
    db = await activeDataDb(caller.env, caller.now.getTime());
  } catch (error) {
    logFailure("data_unavailable", error);
    throw new Refused(await unservable(caller.env));
  }
  const metered = await meter(caller);
  if (!metered.ok) throw new Refused(metered.error);
  return db;
}

/**
 * Runs a core op whose reader calls `admit` before its first read, turning a
 * refusal into its result and a thrown D1 error into `data_unavailable`.
 */
async function answer<T, E extends HandlerError>(
  op: () => Promise<Result<T, E>>,
): Promise<Result<T, E | HandlerError>> {
  try {
    return await op();
  } catch (error) {
    if (error instanceof Refused) return { ok: false, error: error.refusal };
    logFailure("data_unavailable", error);
    return { ok: false, error: DATA_FAILED };
  }
}

export async function lookup(
  ein: string,
  ctx: HandlerContext,
): Promise<Result<OrgResponse, HandlerError>> {
  const caller = await authorizeAs(ctx);
  return caller.ok ? lookupAs(ein, caller.value) : caller;
}

/** `lookup` for a caller already authorized. */
export async function lookupAs(
  ein: string,
  caller: Caller,
): Promise<Result<OrgResponse, HandlerError>> {
  let rowsRead = 0;
  const countRows = (rows: number) => {
    rowsRead += rows;
  };
  const result = await answer(() =>
    lookupOrg(ein, {
      read: async (valid) =>
        new D1OrgReader(await admit(caller), countRows).read(valid),
    }),
  );
  emit({
    event: "org_lookup",
    outcome: result.ok ? "ok" : result.error.code,
    rowsRead,
  });
  return result;
}

export type SearchInput = { query: string; limit?: number | undefined };

export async function search(
  input: SearchInput,
  ctx: HandlerContext,
): Promise<Result<OrgSearchResponse, HandlerError>> {
  const caller = await authorizeAs(ctx);
  return caller.ok ? searchAs(input, caller.value) : caller;
}

/** `search` for a caller already authorized. */
export async function searchAs(
  input: SearchInput,
  caller: Caller,
): Promise<Result<OrgSearchResponse, HandlerError>> {
  let rowsRead = 0;
  let cached = false;
  const countRows = (rows: number) => {
    rowsRead += rows;
  };
  const result = await answer(() =>
    searchOrgs(input, {
      search: async (words, limit) => {
        const found = await cachedSearch(
          await admit(caller),
          words,
          limit,
          countRows,
        );
        cached = found.cached;
        return found.records;
      },
    }),
  );
  emit({
    event: "org_search",
    outcome: result.ok ? "ok" : result.error.code,
    rowsRead,
    cached,
  });
  return result;
}
