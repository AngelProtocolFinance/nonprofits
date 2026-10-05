import type { Client } from "@libsql/client";
import type { Result } from "@nonprofits/core";
import type { RateLimiter } from "./limiter.ts";

export interface Limits {
  daily: number;
  perMinute: number;
}

/** `anonymous`: a request sent with no key, limited per client IP. */
export type Tier = "default" | "whitelisted" | "anonymous";

/** The tiers a valid key can have. */
export type KeyTier = Exclude<Tier, "anonymous">;

/** The tiers inside a service-wide daily limit, whose per-minute limit is a limiter's. */
export type MeteredTier = Exclude<Tier, "whitelisted">;

/** A key with no `key_limits` row. `perMinute` is the key limiter's. */
export const DEFAULT_LIMITS: Limits = { daily: 50, perMinute: 10 };

/** Per client IP, for requests with no key. `perMinute` is the keyless limiter's. */
export const KEYLESS_LIMITS: Limits = { daily: 5, perMinute: 1 };

/** Requests carrying any key, per client per minute, before the key is read: above any whitelisted key's honest traffic, below a bad-key flood. */
export const KEYED_REQUESTS_PER_MINUTE = 600;

/** A key's tier and limits from its `key_limits` columns, both null when it has no row. */
export function limitsOf(
  daily: number | null,
  perMinute: number | null,
): { tier: KeyTier; limits: Limits } {
  return daily === null || perMinute === null
    ? { tier: "default", limits: DEFAULT_LIMITS }
    : { tier: "whitelisted", limits: { daily, perMinute } };
}

/**
 * `key_usage` rows one admitted request writes: a metered one upserts its
 * caller's row and its tier's service row (`COUNT_METERED_SQL`), a
 * whitelisted one only its own (`COUNT_SQL`). A refused request writes none.
 */
export const ROWS_WRITTEN = { metered: 2, whitelisted: 1, refused: 0 };

// Default service-wide daily ceilings, sized so traffic at both stays inside
// Turso's free plan: 500M rows read and 10M rows written a month. A 31-day
// month allows 16,129,032 reads and 322,580 writes a day.
//
// Reads bind. A search ranks up to MAX_CANDIDATES (1,000, org-searcher.ts)
// FTS matches, visiting per match 3 rows: its FTS entry, its `orgs` row and
// its `filings` row, measured with .scanstats: up to 3 x 1,000 = 3,000 rows.
// About 100 more cover the key check, the counters and a lookup's handful. A
// caller picks its query, so a ceiling assumes every request is that worst
// search: 3,100 rows read.
//
// The two ceilings take 3/4 of the daily reads, 12,096,774 / 3,100 = 3,902
// requests, split evenly and rounded down: 1,900 + 1,900 = 3,800 a day,
// 11,780,000 rows read and 3,800 x ROWS_WRITTEN.metered = 7,600 rows
// written, under 3% of the day's writes. The other 4,349,032 reads a day
// (about 1,400 worst searches) are for whitelisted keys, which no ceiling
// bounds, and the monthly import's checks.
//
// That covers admitted traffic only. A refused request writes nothing but
// still reads: a well-formed made-up key 1-3 rows (the `apikey` key index,
// the row, `key_limits`), a quota or ceiling refusal about 5 (the counters).
// No ceiling bounds those reads; only the per-minute limiters do, per
// client (a made-up key's only bound is the 600-a-minute `keyedRequests`
// cap), and the in-memory ones count per instance until the platform's
// limits run in front of the app.
export const DEFAULT_SERVICE_DAILY_LIMIT: Record<MeteredTier, number> = {
  anonymous: 1_900,
  default: 1_900,
};

/** A caller over one of its limits: a 429 with `Retry-After: retryAfterSeconds`. */
export type QuotaError = {
  code:
    | "daily_quota_exceeded"
    | "per_minute_limit_exceeded"
    | "service_daily_limit_reached";
  message: string;
  retryAfterSeconds: number;
};

/** The per-minute limiters' period; they report no reset time, so a refusal waits out a whole one. */
export const BURST_PERIOD_SECONDS = 60;

const KEY_LIFTS_LIMIT =
  "An API key lifts this limit: ask the operator for one.";

/** HTTP requests to `/mcp` per keyless client per minute, whatever messages each carries. */
export const KEYLESS_MCP_REQUESTS_PER_MINUTE = 60;

/** A keyless client over the `/mcp` request limiter. */
export function keylessMcpRefusal(): QuotaError {
  return {
    code: "per_minute_limit_exceeded",
    message: `HTTP requests to /mcp without an API key are limited to ${KEYLESS_MCP_REQUESTS_PER_MINUTE} per minute per IP address, whatever MCP messages each carries. Retry in ${BURST_PERIOD_SECONDS} seconds. ${KEY_LIFTS_LIMIT}`,
    retryAfterSeconds: BURST_PERIOD_SECONDS,
  };
}

/** A client over the keyed-request limiter, whatever keys it sent. */
export function keyedRequestRefusal(): QuotaError {
  return {
    code: "per_minute_limit_exceeded",
    message: `Requests with an API key from one client are limited to ${requests(KEYED_REQUESTS_PER_MINUTE)} per minute. Retry in ${BURST_PERIOD_SECONDS} seconds.`,
    retryAfterSeconds: BURST_PERIOD_SECONDS,
  };
}

/** A metered caller over its tier's per-minute limiter. */
function burstRefusal(tier: MeteredTier, perMinute: number): QuotaError {
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
// guarded writes can't promise. The guards read both rows as they were before
// this insert.
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

/** Days of `key_usage` kept before the run's own: requests read only today's rows, the rest are for the operator. */
const USAGE_RETENTION_DAYS = 7;

/** Deletes usage rows more than `USAGE_RETENTION_DAYS` days before `at`'s UTC day. */
export async function pruneUsage(db: Client, at: Date): Promise<void> {
  const cutoff = utcDay(new Date(at.getTime() - USAGE_RETENTION_DAYS * DAY_MS));
  await db.execute({
    sql: "DELETE FROM key_usage WHERE day < ?1",
    args: [cutoff],
  });
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

async function usedToday(
  db: Client,
  subject: string,
  day: string,
): Promise<number> {
  const used = await db.execute({ sql: USED_TODAY_SQL, args: [subject, day] });
  return Number(used.rows[0]?.requests ?? 0);
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
 * Counts one metered request against the caller's daily quota and its tier's
 * service-wide daily limit, writing both `key_usage` rows when admitted and
 * none when refused. Database errors throw.
 */
async function countMeteredRequest(
  db: Client,
  caller: { subject: string; tier: MeteredTier; daily: number },
  serviceDaily: number,
  now: Date,
): Promise<Result<void, QuotaError>> {
  const { subject, tier, daily } = caller;
  const day = utcDay(now);
  const minute = Math.floor(now.getTime() / MINUTE_MS);
  const counted = await db.execute({
    sql: COUNT_METERED_SQL,
    args: [subject, day, minute, SERVICE_SUBJECT[tier], daily, serviceDaily],
  });
  if (counted.rows.length > 0) return { ok: true, value: undefined };

  const midnight = nextMidnight(day);
  // counts only grow within a day: a caller under its quota now was under it then
  if ((await usedToday(db, subject, day)) >= daily) {
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

/**
 * Counts one whitelisted request against `subject`'s own daily and per-minute
 * limits, outside any service-wide one. Writes one `key_usage` row when
 * admitted and none when refused. Database errors throw.
 */
export async function countRequest(
  db: Client,
  subject: string,
  limits: Limits,
  now: Date,
): Promise<Result<void, QuotaError>> {
  const day = utcDay(now);
  const minute = Math.floor(now.getTime() / MINUTE_MS);
  const counted = await db.execute({
    sql: COUNT_SQL,
    args: [subject, day, minute, limits.daily, limits.perMinute],
  });
  if (counted.rows.length > 0) return { ok: true, value: undefined };

  // refused by one of two guards: under the daily quota means the minute's was hit
  if ((await usedToday(db, subject, day)) < limits.daily) {
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

/** What metering a request reads besides the request itself. */
export interface Meter {
  appDb: Client;
  /** keyless requests per client IP per minute */
  keylessBurst: RateLimiter;
  /** default-tier requests per key per minute */
  keyBurst: RateLimiter;
}

/**
 * Counts one call inside a service-wide daily limit; an uncounted call is
 * never served. The tier's limiter goes first: its count can't be taken
 * back, and the daily counters must not count a request it refuses.
 * Storage and limiter errors throw.
 */
export async function meterMetered(
  meter: Meter,
  caller: { subject: string; tier: MeteredTier; limits: Limits },
  serviceDaily: number,
  now: Date,
): Promise<Result<void, QuotaError>> {
  const { subject, tier, limits } = caller;
  const limiter = tier === "anonymous" ? meter.keylessBurst : meter.keyBurst;
  const burst = await limiter.limit({ key: subject });
  if (!burst.success) {
    return { ok: false, error: burstRefusal(tier, limits.perMinute) };
  }
  return countMeteredRequest(
    meter.appDb,
    { subject, tier, daily: limits.daily },
    serviceDaily,
    now,
  );
}
