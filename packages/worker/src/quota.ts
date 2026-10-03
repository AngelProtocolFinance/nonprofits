import type { Result } from "@nonprofits/core";

export interface Limits {
  daily: number;
  perMinute: number;
}

/** `anonymous`: a request sent with no key, limited per client IP. */
export type Tier = "default" | "whitelisted" | "anonymous";

/** The tiers a valid key can have. */
export type KeyTier = Exclude<Tier, "anonymous">;

/** The tiers inside the service-wide daily limit, whose per-minute limit is a Rate Limiting binding's. */
export type MeteredTier = Exclude<Tier, "whitelisted">;

/** A key with no `key_limits` row. `perMinute` is `KEY_BURST_LIMITER`'s limit in wrangler.jsonc. */
export const DEFAULT_LIMITS: Limits = { daily: 50, perMinute: 10 };

/** Per client IP, for requests with no key. `perMinute` is `KEYLESS_BURST_LIMITER`'s limit in wrangler.jsonc. */
export const KEYLESS_LIMITS: Limits = { daily: 5, perMinute: 1 };

/** A key's tier and limits from its `key_limits` columns, both null when it has no row. */
export function limitsOf(
  daily: number | null,
  perMinute: number | null,
): { tier: KeyTier; limits: Limits } {
  return daily === null || perMinute === null
    ? { tier: "default", limits: DEFAULT_LIMITS }
    : { tier: "whitelisted", limits: { daily, perMinute } };
}

/** A caller over one of its limits: a 429 with `Retry-After: retryAfterSeconds`. */
export type QuotaError = {
  code:
    | "daily_quota_exceeded"
    | "per_minute_limit_exceeded"
    | "service_daily_limit_reached";
  message: string;
  retryAfterSeconds: number;
};

/** The Rate Limiting bindings' `period` in wrangler.jsonc; they report no reset time, so a refusal waits out a whole one. */
const BURST_PERIOD_SECONDS = 60;

const KEY_LIFTS_LIMIT =
  "An API key lifts this limit: ask the operator for one.";

/** `KEYED_REQUEST_LIMITER`'s limit in wrangler.jsonc: requests carrying any key, per client. */
const KEYED_REQUESTS_PER_MINUTE = 600;

/** A client over `KEYED_REQUEST_LIMITER`, whatever keys it sent. */
export function keyedRequestRefusal(): QuotaError {
  return {
    code: "per_minute_limit_exceeded",
    message: `Requests with an API key from one client are limited to ${requests(KEYED_REQUESTS_PER_MINUTE)} per minute. Retry in ${BURST_PERIOD_SECONDS} seconds.`,
    retryAfterSeconds: BURST_PERIOD_SECONDS,
  };
}

/** `KEYLESS_MCP_LIMITER`'s limit in wrangler.jsonc: `/mcp` requests without a key, per client. */
const KEYLESS_MCP_REQUESTS_PER_MINUTE = 60;

/** A keyless client over `KEYLESS_MCP_LIMITER`, whatever MCP messages it sent. */
export function keylessMcpRefusal(): QuotaError {
  return {
    code: "per_minute_limit_exceeded",
    message: `MCP requests without an API key are limited to ${KEYLESS_MCP_REQUESTS_PER_MINUTE} per minute per IP address. Retry in ${BURST_PERIOD_SECONDS} seconds. ${KEY_LIFTS_LIMIT}`,
    retryAfterSeconds: BURST_PERIOD_SECONDS,
  };
}

/** A metered caller over its Rate Limiting binding's per-minute limit. */
export function burstRefusal(tier: MeteredTier, perMinute: number): QuotaError {
  const retry = `Retry in ${BURST_PERIOD_SECONDS} seconds.`;
  return {
    code: "per_minute_limit_exceeded",
    message:
      tier === "anonymous"
        ? `Requests without an API key are limited to ${requests(perMinute)} per minute per IP address. ${retry} ${KEY_LIFTS_LIMIT}`
        : `This key's limit of ${requests(perMinute)} per minute is reached. ${retry}`,
    retryAfterSeconds: BURST_PERIOD_SECONDS,
  };
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// Counts the request only while it is under its limits, so a refused request
// writes nothing and is never counted. SET reads the row as it was before the
// update; a request whose clock runs behind the stored minute joins that minute.
const COUNT_SQL = `
INSERT INTO key_usage (subject, day, requests, minute, minute_requests)
VALUES (?1, ?2, 1, ?3, 1)
ON CONFLICT (subject, day) DO UPDATE SET
  requests = requests + 1,
  minute_requests = iif(excluded.minute > minute, 1, minute_requests + 1),
  minute = max(minute, excluded.minute)
WHERE requests < ?4
  AND (excluded.minute > minute OR minute_requests < ?5)
RETURNING requests`;

/** `key_usage`'s service-wide row per metered tier: no key id or `ip:` subject starts with `*`. */
const SERVICE_SUBJECT: Record<MeteredTier, string> = {
  default: "*:key",
  anonymous: "*:keyless",
};

// Counts the caller (?1) and its tier's service row (?4) in one statement, both or
// neither: a request refused by either limit consumes neither count, which two
// guarded writes can't promise (a D1 batch can't branch on the first one's
// rows). The guards read both rows as they were before this insert.
const COUNT_METERED_SQL = `
INSERT INTO key_usage (subject, day, requests, minute, minute_requests)
SELECT counted.subject, ?2, 1, ?3, 1
FROM (SELECT ?1 AS subject UNION ALL SELECT ?4) AS counted
WHERE coalesce((SELECT requests FROM key_usage WHERE subject = ?1 AND day = ?2), 0) < ?5
  AND coalesce((SELECT requests FROM key_usage WHERE subject = ?4 AND day = ?2), 0) < ?6
ON CONFLICT (subject, day) DO UPDATE SET
  requests = requests + 1,
  minute_requests = iif(excluded.minute > minute, 1, minute_requests + 1),
  minute = max(minute, excluded.minute)
RETURNING subject`;

const USED_TODAY_SQL =
  "SELECT requests FROM key_usage WHERE subject = ?1 AND day = ?2";

/** The UTC day `at` falls in, as `key_usage.day` stores it. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function instant(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

function requests(count: number): string {
  return count === 1 ? "1 request" : `${count} requests`;
}

function secondsUntil(ms: number, now: Date): number {
  return Math.max(1, Math.ceil((ms - now.getTime()) / 1000));
}

function nextMidnight(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) + DAY_MS;
}

/**
 * Counts one metered request against the caller's daily quota and its tier's
 * service-wide daily limit, writing both `key_usage` rows when admitted and
 * none when refused. D1 errors throw.
 */
export async function countMeteredRequest(
  db: D1Database,
  caller: { subject: string; tier: MeteredTier; daily: number },
  serviceDaily: number,
  now: Date,
): Promise<Result<void, QuotaError>> {
  const { subject, tier, daily } = caller;
  const day = utcDay(now);
  const minute = Math.floor(now.getTime() / MINUTE_MS);
  const counted = await db
    .prepare(COUNT_METERED_SQL)
    .bind(subject, day, minute, SERVICE_SUBJECT[tier], daily, serviceDaily)
    .all();
  if (counted.results.length > 0) return { ok: true, value: undefined };

  const midnight = nextMidnight(day);
  // counts only grow within a day: a caller under its quota now was under it then
  const { results } = await db
    .prepare(USED_TODAY_SQL)
    .bind(subject, day)
    .all<{ requests: number }>();
  if ((results[0]?.requests ?? 0) >= daily) {
    return { ok: false, error: dailyRefusal(tier, daily, midnight, now) };
  }
  const reset = `It resets at ${instant(midnight)} (UTC midnight).`;
  return {
    ok: false,
    error: {
      code: "service_daily_limit_reached",
      message:
        tier === "anonymous"
          ? `The service-wide daily limit for requests without an API key is reached. ${reset} ${KEY_LIFTS_LIMIT}`
          : `The service-wide daily limit for default-tier keys is reached. ${reset} Keys with their own limits from the operator are not affected.`,
      retryAfterSeconds: secondsUntil(midnight, now),
    },
  };
}

function dailyRefusal(
  tier: Tier,
  daily: number,
  midnight: number,
  now: Date,
): QuotaError {
  const reset = `${instant(midnight)} (UTC midnight)`;
  return {
    code: "daily_quota_exceeded",
    message:
      tier === "anonymous"
        ? `Requests without an API key are limited to ${requests(daily)} a UTC day per IP address, and this address has used them. They reset at ${reset}. ${KEY_LIFTS_LIMIT}`
        : `This key's daily quota of ${requests(daily)} is used up. It resets at ${reset}.`,
    retryAfterSeconds: secondsUntil(midnight, now),
  };
}

/**
 * Counts one whitelisted request against `subject`'s own daily and per-minute
 * limits, outside the service-wide one. Writes one `key_usage` row when
 * admitted and none when refused. D1 errors throw.
 */
export async function countRequest(
  db: D1Database,
  subject: string,
  limits: Limits,
  now: Date,
): Promise<Result<void, QuotaError>> {
  const day = utcDay(now);
  const minute = Math.floor(now.getTime() / MINUTE_MS);
  const counted = await db
    .prepare(COUNT_SQL)
    .bind(subject, day, minute, limits.daily, limits.perMinute)
    .all();
  if (counted.results.length > 0) return { ok: true, value: undefined };

  // refused by one of two guards: under the daily quota means the minute's was hit
  const { results } = await db
    .prepare(USED_TODAY_SQL)
    .bind(subject, day)
    .all<{ requests: number }>();
  const usedToday = results[0]?.requests ?? 0;
  if (usedToday < limits.daily) {
    const nextMinute = (minute + 1) * MINUTE_MS;
    return {
      ok: false,
      error: {
        code: "per_minute_limit_exceeded",
        message: `This key's limit of ${requests(limits.perMinute)} per minute is reached. Retry at ${instant(nextMinute)}.`,
        retryAfterSeconds: secondsUntil(nextMinute, now),
      },
    };
  }
  return {
    ok: false,
    error: dailyRefusal("whitelisted", limits.daily, nextMidnight(day), now),
  };
}

/** Days of `key_usage` kept before the run's own: requests read only today's rows, the rest are for the operator. */
const USAGE_RETENTION_DAYS = 7;

/** Deletes usage rows more than `USAGE_RETENTION_DAYS` days before `at`'s UTC day. */
export async function pruneUsage(db: D1Database, at: Date): Promise<void> {
  const cutoff = utcDay(new Date(at.getTime() - USAGE_RETENTION_DAYS * DAY_MS));
  await db.prepare("DELETE FROM key_usage WHERE day < ?1").bind(cutoff).run();
}
