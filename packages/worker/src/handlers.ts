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
  countRequest,
  type Limits,
  limitsOf,
  type QuotaError,
  type Tier,
} from "./quota.ts";

/** What every transport (REST, MCP) hands a handler. */
export interface HandlerContext {
  env: Env;
  credential: string | null;
  now: Date;
}

/** Why a caller's credential was refused; each is a 401 on every transport. */
export type AuthError = {
  code: "missing_api_key" | "invalid_api_key" | "revoked_api_key";
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

/** The caller a valid key stands for. A whitelisted key has its own limits, set by `keys set-limit`. */
export interface Principal {
  keyId: string;
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
 * `authorize` refuses as malformed rather than missing.
 */
export function bearerCredential(authorization: string | null): string | null {
  if (authorization === null) return null;
  return /^Bearer +(\S+)$/i.exec(authorization)?.[1] ?? "";
}

/** The `WWW-Authenticate` value a key refusal carries; a sent-but-refused key is `invalid_token` (RFC 6750 §3.1). */
export function challenge(error: HandlerError): string | null {
  switch (error.code) {
    case "missing_api_key":
      return 'Bearer realm="nonprofits"';
    case "invalid_api_key":
    case "revoked_api_key":
      return 'Bearer realm="nonprofits", error="invalid_token"';
    default:
      return null;
  }
}

/** Every key refusal ends by saying how to get a key. */
function refuse(
  code: AuthError["code"],
  reason: string,
): Result<never, AuthError> {
  // a sent key that was refused is routine traffic, logged without key material
  if (code !== "missing_api_key") console.info(`api key refused: ${code}`);
  return {
    ok: false,
    error: {
      code,
      message: `${reason} To get a key, ask the operator; self-serve signup is coming.`,
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

function unavailable(cause: unknown): Result<never, AuthUnavailable> {
  logFailure("auth_unavailable", cause);
  return {
    ok: false,
    error: {
      code: "auth_unavailable",
      message:
        "The key check is unavailable right now; nothing is wrong with your key. Retry shortly.",
    },
  };
}

/** The key guard every transport runs before any quota or data read. */
export async function authorize(
  credential: string | null,
  env: Env,
): Promise<Result<Principal, AuthError | AuthUnavailable>> {
  if (credential === null) {
    return refuse(
      "missing_api_key",
      "No API key sent. Send one as `Authorization: Bearer <key>`.",
    );
  }
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
    value: { keyId: stored.id, ...limitsOf(stored.daily, stored.perMinute) },
  };
}

/** Gate, then quota: a refused key is never counted, and an uncounted request is never served. */
async function admit(
  ctx: HandlerContext,
): Promise<Result<Principal, HandlerError>> {
  const authorized = await authorize(ctx.credential, ctx.env);
  if (!authorized.ok) return authorized;
  const principal = authorized.value;
  let counted: Result<void, QuotaError>;
  try {
    counted = await countRequest(
      ctx.env.DB,
      principal.keyId,
      {
        daily: principal.limits.daily,
        // a default key's per-minute limit is the Rate Limiting binding's
        perMinute:
          principal.tier === "whitelisted" ? principal.limits.perMinute : null,
      },
      ctx.now,
    );
  } catch (error) {
    return unavailable(error);
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
