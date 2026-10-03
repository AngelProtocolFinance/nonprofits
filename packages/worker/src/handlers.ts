import { API_KEY_TABLE_NAME, defaultKeyHasher } from "@better-auth/api-key";
import {
  lookupOrg,
  type OrgLookupError,
  type OrgResponse,
  type OrgSearchError,
  type OrgSearchResponse,
  type Result,
  searchOrgs,
} from "@nonprofits/core";
import { API_KEY_LETTERS, API_KEY_PREFIX, getAuth } from "./auth.ts";
import { D1OrgReader } from "./d1-org-reader.ts";
import { D1OrgSearcher } from "./d1-org-searcher.ts";

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

/** Every refusal a handler can return; transports map each `code`. */
export type HandlerError =
  | OrgLookupError
  | OrgSearchError
  | AuthError
  | AuthUnavailable;

/** The caller a valid key stands for. */
export interface Principal {
  keyId: string;
  tier: "default";
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
  return {
    ok: false,
    error: {
      code,
      message: `${reason} To get a key, ask the operator; self-serve signup is coming.`,
    },
  };
}

function unavailable(cause: unknown): Result<never, AuthUnavailable> {
  console.error(
    JSON.stringify({
      event: "auth_unavailable",
      cause: cause instanceof Error ? `${cause.name}: ${cause.message}` : cause,
    }),
  );
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
  const auth = getAuth(env);
  let verified: Awaited<ReturnType<typeof auth.api.verifyApiKey>>;
  try {
    verified = await auth.api.verifyApiKey({ body: { key: credential } });
  } catch (error) {
    return unavailable(error);
  }
  // revoking disables the key rather than deleting it, so it can be named here
  if (verified.error?.code === "KEY_DISABLED") {
    return refuse("revoked_api_key", "API key has been revoked.");
  }
  if (!verified.valid || verified.key === null) {
    // the plugin reports a failed read or write as INVALID_API_KEY too: a stored key means it was storage
    try {
      const { adapter } = await auth.$context;
      const stored = await adapter.findOne({
        model: API_KEY_TABLE_NAME,
        where: [{ field: "key", value: await defaultKeyHasher(credential) }],
        select: ["id"],
      });
      if (stored !== null) return unavailable(verified.error);
    } catch (error) {
      return unavailable(error);
    }
    return refuse(
      "invalid_api_key",
      "API key not recognized: check it was copied whole.",
    );
  }
  return { ok: true, value: { keyId: verified.key.id, tier: "default" } };
}

/** Gate, then quota. */
async function admit(
  ctx: HandlerContext,
): Promise<Result<Principal, HandlerError>> {
  return authorize(ctx.credential, ctx.env);
}

function emit(metrics: { event: string; outcome: string; rowsRead: number }) {
  console.log(JSON.stringify(metrics));
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
  const result = await lookupOrg(ein, reader);
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
  const result = await searchOrgs(input, searcher);
  emit({
    event: "org_search",
    outcome: result.ok ? "ok" : result.error.code,
    rowsRead,
  });
  return result;
}
