import type { Client } from "@libsql/client";
import {
  lookupOrg,
  type OrgLookupError,
  type OrgResponse,
  type OrgSearchError,
  type OrgSearchResponse,
  type Result,
  searchOrgs,
} from "@nonprofits/core";
import {
  type AuthError,
  type AuthUnavailable,
  authorize,
  type ClientRequest,
  KEY_CHECK_UNAVAILABLE,
  KEYLESS_UNAVAILABLE,
  type Principal,
  unavailable,
} from "./authorize.ts";
import { countOf } from "./count.ts";
import {
  DataNotLoaded,
  type ServedData,
  type ServedDataResolver,
} from "./data-db.ts";
import type { RateLimiter } from "./limiter.ts";
import { logFailure } from "./log.ts";
import { readOrg } from "./org-reader.ts";
import { searchNames } from "./org-searcher.ts";
import {
  countRequest,
  DEFAULT_SERVICE_DAILY_LIMIT,
  keylessMcpRefusal,
  type MeteredTier,
  meterMetered,
  type QuotaError,
} from "./quota.ts";

/** A data read failed: a 503 the caller can retry, never a bare 500. */
export type DataUnavailable = { code: "data_unavailable"; message: string };

/** Every refusal a handler can return; transports map each `code`. */
export type HandlerError =
  | OrgLookupError
  | OrgSearchError
  | AuthError
  | AuthUnavailable
  | QuotaError
  | DataUnavailable;

/** Secrets and vars, as the platform hands them over: every value may be unset, and a number may arrive as text. */
export interface ApiVars {
  /** keys the hash that stands in for a client's IP; requests are refused until it is set */
  IP_HASH_SECRET?: string | undefined;
  /** keyless requests a UTC day, across every client; unset is the default, and anything else but a positive integer refuses requests */
  SERVICE_KEYLESS_DAILY_LIMIT?: string | number | undefined;
  /** default-tier key requests a UTC day, across every key; read as `SERVICE_KEYLESS_DAILY_LIMIT` is */
  SERVICE_KEY_DAILY_LIMIT?: string | number | undefined;
  /** the bearer token the key CLI sends; the admin routes stay off until it is set */
  ADMIN_TOKEN?: string | undefined;
  /** better-auth's signing secret; the admin routes stay off until it is set */
  BETTER_AUTH_SECRET?: string | undefined;
}

/** What every handler reads besides its request, built once per app. */
export interface Service {
  appDb: Client;
  servedData: ServedDataResolver;
  keylessBurst: RateLimiter;
  keyBurst: RateLimiter;
  keyedRequests: RateLimiter;
  keylessMcpRequests: RateLimiter;
  vars: ApiVars;
}

/** A request on its way to a handler: the service, who sent it, and when. */
export interface HandlerContext {
  service: Service;
  request: ClientRequest;
  now: Date;
}

/**
 * A request `authorize` accepted: who each of its calls is counted as. MCP
 * authorizes once per HTTP request and runs its tool calls as this.
 */
export interface Caller {
  service: Service;
  principal: Principal;
  now: Date;
}

/** The caller a request is, before any quota is read: a refused credential is never counted against a daily quota. */
export async function authorizeAs(
  ctx: HandlerContext,
): Promise<Result<Caller, HandlerError>> {
  const { service } = ctx;
  const authorized = await authorize(
    ctx.request,
    {
      appDb: service.appDb,
      keyedRequests: service.keyedRequests,
      ipHashSecret: service.vars.IP_HASH_SECRET,
    },
    ctx.now,
  );
  if (!authorized.ok) return authorized;
  return {
    ok: true,
    value: { service: ctx.service, principal: authorized.value, now: ctx.now },
  };
}

/**
 * Caps a keyless client's HTTP requests to `/mcp` per minute, whatever
 * messages each carries: handshakes and tool listings aren't metered, and
 * nothing else bounds them. A keyed client's are capped before its key is
 * read (`keyedRequests`).
 */
export async function limitKeylessMcpRequests(
  caller: Caller,
): Promise<Result<void, QuotaError | AuthUnavailable>> {
  const { principal, service } = caller;
  if (principal.tier !== "anonymous") return { ok: true, value: undefined };
  try {
    const { success } = await service.keylessMcpRequests.limit({
      key: principal.subject,
    });
    return success
      ? { ok: true, value: undefined }
      : { ok: false, error: keylessMcpRefusal() };
  } catch (error) {
    return unavailable(error, KEYLESS_UNAVAILABLE);
  }
}

const SERVICE_DAILY_VAR = {
  anonymous: "SERVICE_KEYLESS_DAILY_LIMIT",
  default: "SERVICE_KEY_DAILY_LIMIT",
} as const satisfies Record<MeteredTier, keyof ApiVars>;

/** A tier's service-wide daily limit: its default while unset, null when set to anything but a positive integer. */
function serviceDailyOf(vars: ApiVars, tier: MeteredTier): number | null {
  const value = vars[SERVICE_DAILY_VAR[tier]];
  return value === undefined
    ? DEFAULT_SERVICE_DAILY_LIMIT[tier]
    : countOf(value);
}

/** Counts the call; a misset limit, storage or limiter errors leave it uncounted and unserved. */
async function meter(caller: Caller): Promise<Result<void, HandlerError>> {
  const { service, principal, now } = caller;
  const { subject, tier, limits } = principal;
  const unavailableMessage =
    tier === "anonymous" ? KEYLESS_UNAVAILABLE : KEY_CHECK_UNAVAILABLE;
  try {
    if (tier === "whitelisted") {
      return await countRequest(service.appDb, subject, limits, now);
    }
    const serviceDaily = serviceDailyOf(service.vars, tier);
    if (serviceDaily === null) {
      return unavailable(
        `${SERVICE_DAILY_VAR[tier]} is not a positive integer`,
        unavailableMessage,
      );
    }
    return await meterMetered(
      service,
      { subject, tier, limits },
      serviceDaily,
      now,
    );
  } catch (error) {
    return unavailable(error, unavailableMessage);
  }
}

function emit(metrics: { event: string; outcome: string }) {
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

/** Ends a core op from inside its reader, with a refusal the op can't return itself. */
class Refused extends Error {
  readonly refusal: HandlerError;

  constructor(refusal: HandlerError) {
    super(refusal.code);
    this.refusal = refusal;
  }
}

/**
 * Reads the served data database for a call core has validated: resolved,
 * then the call counted, then `read`. Invalid input never gets here, and a
 * call no data database resolves for is refused uncounted; a call whose read
 * fails was counted already, and drops the client it read so the next call
 * resolves again.
 */
async function readServed<T>(
  caller: Caller,
  read: (db: Client) => Promise<T>,
): Promise<T> {
  const { servedData } = caller.service;
  let served: ServedData;
  try {
    served = await servedData.serve(caller.now.getTime());
  } catch (error) {
    if (error instanceof DataNotLoaded) throw new Refused(DATA_NOT_LOADED);
    logFailure("data_unavailable", error);
    throw new Refused(DATA_FAILED);
  }
  const metered = await meter(caller);
  if (!metered.ok) throw new Refused(metered.error);
  try {
    return await read(served.client);
  } catch (error) {
    servedData.forget(served.client);
    throw error;
  }
}

/**
 * Runs a core op whose reader goes through `readServed`, turning a
 * refusal into its result and a thrown read error into `data_unavailable`.
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
  const result = await answer(() =>
    lookupOrg(ein, {
      read: (valid) => readServed(caller, (db) => readOrg(db, valid)),
    }),
  );
  emit({
    event: "org_lookup",
    outcome: result.ok ? "ok" : result.error.code,
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
  const result = await answer(() =>
    searchOrgs(input, {
      search: (words, limit) =>
        readServed(caller, (db) => searchNames(db, words, limit)),
    }),
  );
  emit({
    event: "org_search",
    outcome: result.ok ? "ok" : result.error.code,
  });
  return result;
}
