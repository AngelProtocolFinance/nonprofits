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
  type AuthUnavailable,
  authorize,
  type ClientRequest,
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
import { meterKeyless, type QuotaError } from "./quota.ts";

/** A data read failed: a 503 the caller can retry, never a bare 500. */
export type DataUnavailable = { code: "data_unavailable"; message: string };

/** Every refusal a handler can return; transports map each `code`. */
export type HandlerError =
  | OrgLookupError
  | OrgSearchError
  | AuthUnavailable
  | QuotaError
  | DataUnavailable;

/** Secrets and vars, as the platform hands them over: every value may be unset, and a number may arrive as text. */
export interface ApiVars {
  /** keys the hash that stands in for a client's IP; requests are refused until it is set */
  IP_HASH_SECRET?: string | undefined;
  /** keyless requests a UTC day, across every client; requests are refused unless a positive integer */
  SERVICE_KEYLESS_DAILY_LIMIT?: string | number | undefined;
}

/** What every handler reads besides its request, built once per app. */
export interface Service {
  appDb: Client;
  servedData: ServedDataResolver;
  keylessBurst: RateLimiter;
  vars: ApiVars;
}

/** A request on its way to a handler: the service, who sent it, and when. */
export interface HandlerContext {
  service: Service;
  request: ClientRequest;
  now: Date;
}

/** A request `authorize` accepted: who its call is counted as. */
interface Caller {
  service: Service;
  principal: Principal;
  now: Date;
}

async function authorizeAs(
  ctx: HandlerContext,
): Promise<Result<Caller, HandlerError>> {
  const authorized = await authorize(
    ctx.request,
    ctx.service.vars.IP_HASH_SECRET,
  );
  if (!authorized.ok) return authorized;
  return {
    ok: true,
    value: { service: ctx.service, principal: authorized.value, now: ctx.now },
  };
}

/** Counts the call; storage or limiter errors leave it uncounted and unserved. */
async function meter(caller: Caller): Promise<Result<void, HandlerError>> {
  const serviceDaily = countOf(caller.service.vars.SERVICE_KEYLESS_DAILY_LIMIT);
  if (serviceDaily === null) {
    return unavailable(
      "SERVICE_KEYLESS_DAILY_LIMIT is not a positive integer",
      KEYLESS_UNAVAILABLE,
    );
  }
  try {
    return await meterKeyless(
      { ...caller.service, serviceDaily },
      caller.principal.subject,
      caller.now,
    );
  } catch (error) {
    return unavailable(error, KEYLESS_UNAVAILABLE);
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
  if (!caller.ok) return caller;
  const result = await answer(() =>
    lookupOrg(ein, {
      read: (valid) => readServed(caller.value, (db) => readOrg(db, valid)),
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
  if (!caller.ok) return caller;
  const result = await answer(() =>
    searchOrgs(input, {
      search: (words, limit) =>
        readServed(caller.value, (db) => searchNames(db, words, limit)),
    }),
  );
  emit({
    event: "org_search",
    outcome: result.ok ? "ok" : result.error.code,
  });
  return result;
}
