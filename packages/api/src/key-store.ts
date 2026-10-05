import type { Client } from "@libsql/client";
import { rowsOf } from "./rows.ts";

// The one module whose SQL names better-auth's tables (`apikey`, `user`) or
// their columns, which are better-auth's layout, not ours.
// `auth.generate.test.ts` holds the app migrations to the columns better-auth
// expects, and each caller's tests run these statements against them.

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
 * rule `authorize` would skip, so it is refused.
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

export interface StoredKey extends PluginFields {
  id: string;
  enabled: number | null;
  expiresAt: string | null;
  daily: number | null;
  perMinute: number | null;
}

/** The plugin fields a stored key holds at other than `PLUGIN_DEFAULTS`. */
export function unsupportedFields(stored: StoredKey): string[] {
  return Object.entries(PLUGIN_DEFAULTS)
    .filter(([field, value]) => stored[field as keyof PluginFields] !== value)
    .map(([field]) => field);
}

/** The stored key whose hash is `hashedKey`, if one is. */
export async function readStoredKey(
  appDb: Client,
  hashedKey: string,
): Promise<StoredKey | undefined> {
  const found = await appDb.execute({ sql: KEY_SQL, args: [hashedKey] });
  return rowsOf<StoredKey>(found)[0];
}

const SET_LIMITS_SQL = `
INSERT INTO key_limits (key_id, daily, per_minute)
SELECT id, ?2, ?3 FROM apikey WHERE id = ?1
ON CONFLICT (key_id) DO UPDATE SET daily = excluded.daily, per_minute = excluded.per_minute
RETURNING key_id`;

/** Whitelists a key with its own limits, replacing any it had; false when no key has that id. */
export async function setKeyLimits(
  appDb: Client,
  keyId: string,
  limits: { daily: number; perMinute: number },
): Promise<boolean> {
  const result = await appDb.execute({
    sql: SET_LIMITS_SQL,
    args: [keyId, limits.daily, limits.perMinute],
  });
  return result.rows.length > 0;
}

/** Returns a key to the default tier; false when no key has that id. */
export async function clearKeyLimits(
  appDb: Client,
  keyId: string,
): Promise<boolean> {
  const [, key] = await appDb.batch(
    [
      { sql: "DELETE FROM key_limits WHERE key_id = ?1", args: [keyId] },
      { sql: "SELECT id FROM apikey WHERE id = ?1", args: [keyId] },
    ],
    "write",
  );
  return rowsOf(key).length > 0;
}

/** One `apikey` row as `keys list` shows it: never the key or its hash. */
export interface KeyRow {
  id: string;
  name: string | null;
  ownerEmail: string;
  /** 0 once revoked */
  enabled: number | null;
  daily: number | null;
  perMinute: number | null;
  usedToday: number;
}

const LIST_SQL = `
SELECT k.id, k.name, u.email AS ownerEmail, k.enabled, l.daily,
  l.per_minute AS perMinute, coalesce(g.requests, 0) AS usedToday
FROM apikey k
JOIN "user" u ON u.id = k.referenceId
LEFT JOIN key_limits l ON l.key_id = k.id
LEFT JOIN key_usage g ON g.subject = k.id AND g.day = ?1
ORDER BY k.createdAt, k.id`;

/** Every key, oldest first, with its limits and its requests on `day`. */
export async function listKeyRows(
  appDb: Client,
  day: string,
): Promise<KeyRow[]> {
  return rowsOf<KeyRow>(await appDb.execute({ sql: LIST_SQL, args: [day] }));
}
