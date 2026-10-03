import {
  lookupOrg,
  type OrgLookupError,
  type OrgResponse,
  type Result,
} from "@nonprofits/core";
import { API_KEY_PREFIX, getAuth } from "./auth.ts";
import { D1OrgReader } from "./d1-org-reader.ts";

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

/** Every refusal a handler can return; transports map each `code`. */
export type HandlerError = OrgLookupError | AuthError;

/** The caller a valid key stands for. */
export interface Principal {
  keyId: string;
  tier: "default";
}

const KEY_FORMAT = new RegExp(`^${API_KEY_PREFIX}[A-Za-z]{64}$`);

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

/** The key guard every transport runs before any quota or data read. */
export async function authorize(
  credential: string | null,
  env: Env,
): Promise<Result<Principal, AuthError>> {
  if (credential === null) {
    return refuse(
      "missing_api_key",
      "No API key sent. Send one as `Authorization: Bearer <key>`.",
    );
  }
  if (!KEY_FORMAT.test(credential)) {
    return refuse(
      "invalid_api_key",
      `API key is malformed: expected \`${API_KEY_PREFIX}\` followed by 64 letters, sent as \`Authorization: Bearer <key>\`.`,
    );
  }
  const verified = await getAuth(env).api.verifyApiKey({
    body: { key: credential },
  });
  // revoking disables the key rather than deleting it, so it can be named here
  if (verified.error?.code === "KEY_DISABLED") {
    return refuse("revoked_api_key", "API key has been revoked.");
  }
  if (!verified.valid || verified.key === null) {
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
