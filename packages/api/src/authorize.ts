import { defaultKeyHasher } from "@better-auth/api-key";
import type { Client } from "@libsql/client";
import type { Result } from "@nonprofits/core";
import { ipAddress } from "@vercel/functions";
import { clientSubject } from "./client.ts";
import type { RateLimiter } from "./limiter.ts";
import { logFailure } from "./log.ts";
import {
  KEYLESS_LIMITS,
  keyedRequestRefusal,
  type Limits,
  limitsOf,
  type QuotaError,
  type Tier,
} from "./quota.ts";
import { rowsOf } from "./rows.ts";
import { isSecretSet } from "./secret.ts";

/** Every issued key is this prefix plus `API_KEY_LETTERS` ASCII letters. */
export const API_KEY_PREFIX = "npk_";
export const API_KEY_LETTERS = 64;

/** What `authorize` reads from a request, by name so no two can be swapped. */
export interface ClientRequest {
  /** The key sent as `Authorization: Bearer <key>`; null: no `Authorization` header, so the request is keyless. */
  credential: string | null;
  /**
   * The client's IP from `x-real-ip`, which Vercel sets on every request and
   * overwrites when a client sends its own: a header a client can set
   * would let it mint fresh quota by rotating it.
   */
  clientIp: string | null;
}

/**
 * The key in an `Authorization: Bearer <key>` header, for every transport.
 * Any other value is sent the wrong way, so it comes back as "", which
 * `authorize` refuses as malformed rather than serving it keyless.
 */
function bearerCredential(authorization: string | null): string | null {
  if (authorization === null) return null;
  return /^Bearer +(\S+)$/i.exec(authorization)?.[1] ?? "";
}

/** The client a request is, read from its headers the same way on every transport. */
export function clientRequestOf(request: Request): ClientRequest {
  return {
    credential: bearerCredential(request.headers.get("authorization")),
    clientIp: ipAddress(request) ?? null,
  };
}

/** Why a sent credential was refused; each is a 401 on every transport. */
export type AuthError = {
  code: "invalid_api_key" | "revoked_api_key";
  message: string;
};

/** The request can't be checked or counted, so it isn't served: a 503, never a pass or a 401. */
export type AuthUnavailable = { code: "auth_unavailable"; message: string };

export const KEYLESS_UNAVAILABLE =
  "Requests without an API key can't be served right now. Retry later, or send an API key.";

export const KEY_CHECK_UNAVAILABLE =
  "The key check is unavailable right now, so this refusal says nothing about your key. Retry shortly.";

export function unavailable(
  cause: unknown,
  message: string,
): Result<never, AuthUnavailable> {
  logFailure("auth_unavailable", cause);
  return { ok: false, error: { code: "auth_unavailable", message } };
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

/**
 * Who a request is counted as: a valid key (`subject` is its id; a whitelisted
 * key has its own limits from its `key_limits` row), or with no key a client
 * IP (`subject` is `ip:` and its keyed hash).
 */
export interface Principal {
  subject: string;
  tier: Tier;
  limits: Limits;
}

/** What `authorize` reads besides the request. */
export interface KeyGuard {
  appDb: Client;
  /** requests carrying any key, per client, counted before the key is read */
  keyedRequests: RateLimiter;
  ipHashSecret: string | undefined;
}

/**
 * The plugin's `apikey` row for a hashed key, with its limits, read directly:
 * the plugin's `verifyApiKey` writes the row on every call (`lastRequest`,
 * `updatedAt`) and has no option that stops it in database storage.
 * `enabled` is 0 once revoked.
 */
const KEY_SQL = `
SELECT k.id, k.enabled, k.expiresAt, k.configId, k.remaining, k.refillAmount,
  k.refillInterval, k.rateLimitEnabled, k.permissions,
  l.daily, l.per_minute AS perMinute
FROM apikey k LEFT JOIN key_limits l ON l.key_id = k.id
WHERE k.key = ?1`;

/**
 * The `apikey` columns the plugin's `verifyApiKey` enforces and `authorize`
 * doesn't, at the values the plugin writes for a key issued with the
 * project's options (api-key 1.7.7). A row holding anything else carries a
 * rule this guard would skip, so it is refused.
 */
const PLUGIN_DEFAULTS = {
  configId: "default",
  remaining: null,
  refillAmount: null,
  refillInterval: null,
  rateLimitEnabled: 0,
  permissions: null,
} as const;

type PluginFields = {
  [field in keyof typeof PLUGIN_DEFAULTS]: string | number | null;
};

interface StoredKey extends PluginFields {
  id: string;
  enabled: number | null;
  expiresAt: string | null;
  daily: number | null;
  perMinute: number | null;
}

function unsupportedFields(stored: StoredKey): string[] {
  return Object.entries(PLUGIN_DEFAULTS)
    .filter(([field, value]) => stored[field as keyof PluginFields] !== value)
    .map(([field]) => field);
}

const KEY_FORMAT = new RegExp(
  `^${API_KEY_PREFIX}[A-Za-z]{${API_KEY_LETTERS}}$`,
);

/** The request's client as a usage subject, or unavailable while the secret keying its hash is unset. */
function subjectOf(
  request: ClientRequest,
  ipHashSecret: string | undefined,
  unavailableMessage: string,
): Result<string, AuthUnavailable> {
  if (!isSecretSet(ipHashSecret)) {
    return unavailable(
      "IP_HASH_SECRET is unset or a placeholder: requests refused",
      unavailableMessage,
    );
  }
  return { ok: true, value: clientSubject(request.clientIp, ipHashSecret) };
}

/**
 * Caps requests carrying any key per client before the key is read, so a
 * stream of bad keys can't turn into one key-store read each.
 */
async function limitKeyedRequests(
  request: ClientRequest,
  guard: KeyGuard,
): Promise<Result<void, QuotaError | AuthUnavailable>> {
  const client = subjectOf(request, guard.ipHashSecret, KEY_CHECK_UNAVAILABLE);
  if (!client.ok) return client;
  try {
    const { success } = await guard.keyedRequests.limit({ key: client.value });
    return success
      ? { ok: true, value: undefined }
      : { ok: false, error: keyedRequestRefusal() };
  } catch (error) {
    return unavailable(error, KEY_CHECK_UNAVAILABLE);
  }
}

/** The guard every transport runs before any quota or data read: a sent key, or none at all. */
export async function authorize(
  request: ClientRequest,
  guard: KeyGuard,
  now: Date,
): Promise<Result<Principal, AuthError | AuthUnavailable | QuotaError>> {
  const { credential } = request;
  if (credential === null) {
    const client = subjectOf(request, guard.ipHashSecret, KEYLESS_UNAVAILABLE);
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
  const limited = await limitKeyedRequests(request, guard);
  if (!limited.ok) return limited;
  if (!KEY_FORMAT.test(credential)) {
    return refuse(
      "invalid_api_key",
      `API key is malformed: expected \`${API_KEY_PREFIX}\` followed by ${API_KEY_LETTERS} letters, sent as \`Authorization: Bearer <key>\`.`,
    );
  }
  let stored: StoredKey | undefined;
  try {
    const found = await guard.appDb.execute({
      sql: KEY_SQL,
      // the plugin's own hasher, whose output a test vector pins (keyed.test.ts)
      args: [await defaultKeyHasher(credential)],
    });
    stored = rowsOf<StoredKey>(found)[0];
  } catch (error) {
    return unavailable(error, KEY_CHECK_UNAVAILABLE);
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
  if (
    stored.expiresAt !== null &&
    Date.parse(stored.expiresAt) <= now.getTime()
  ) {
    return refuse("invalid_api_key", "API key has expired.");
  }
  const unsupported = unsupportedFields(stored);
  if (unsupported.length > 0) {
    console.error(
      JSON.stringify({
        event: "api_key_unsupported_fields",
        keyId: stored.id,
        fields: unsupported,
      }),
    );
    return refuse(
      "invalid_api_key",
      "API key can't be used here: ask the operator for a new one.",
    );
  }
  return {
    ok: true,
    value: { subject: stored.id, ...limitsOf(stored.daily, stored.perMinute) },
  };
}
