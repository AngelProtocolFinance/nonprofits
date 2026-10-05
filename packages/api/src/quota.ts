import type { Client } from "@libsql/client";
import type { Result } from "@nonprofits/core";
import type { RateLimiter } from "./limiter.ts";

export interface Limits {
  daily: number;
  perMinute: number;
}

/** Per client IP, for requests with no key. `perMinute` is the keyless limiter's. */
export const KEYLESS_LIMITS: Limits = { daily: 5, perMinute: 1 };

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

/** A keyless client over the per-minute limiter. */
function keylessBurstRefusal(): QuotaError {
  return {
    code: "per_minute_limit_exceeded",
    message: `Requests without an API key are limited to ${requests(KEYLESS_LIMITS.perMinute)} per minute per IP address. Retry in ${BURST_PERIOD_SECONDS} seconds. ${KEY_LIFTS_LIMIT}`,
    retryAfterSeconds: BURST_PERIOD_SECONDS,
  };
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** `key_usage`'s service-wide row for keyless traffic: no key id or `ip:` subject starts with `*`. */
const KEYLESS_SERVICE_SUBJECT = "*:keyless";

// Counts the caller (?1) and the keyless service row (?4) in one statement, both or
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
function utcDay(at: Date): string {
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

/**
 * Counts one keyless request against its client's daily quota and the
 * service-wide keyless daily limit, writing both `key_usage` rows when
 * admitted and none when refused. Database errors throw.
 */
async function countKeylessRequest(
  db: Client,
  subject: string,
  serviceDaily: number,
  now: Date,
): Promise<Result<void, QuotaError>> {
  const day = utcDay(now);
  const minute = Math.floor(now.getTime() / MINUTE_MS);
  const counted = await db.execute({
    sql: COUNT_METERED_SQL,
    args: [
      subject,
      day,
      minute,
      KEYLESS_SERVICE_SUBJECT,
      KEYLESS_LIMITS.daily,
      serviceDaily,
    ],
  });
  if (counted.rows.length > 0) return { ok: true, value: undefined };

  const midnight = Date.parse(`${day}T00:00:00Z`) + DAY_MS;
  const reset = `${instant(midnight)} (UTC midnight)`;
  // counts only grow within a day: a caller under its quota now was under it then
  const used = await db.execute({
    sql: USED_TODAY_SQL,
    args: [subject, day],
  });
  if (Number(used.rows[0]?.requests ?? 0) >= KEYLESS_LIMITS.daily) {
    return {
      ok: false,
      error: {
        code: "daily_quota_exceeded",
        message: `Requests without an API key are limited to ${requests(KEYLESS_LIMITS.daily)} a UTC day per IP address, and this address has used them. They reset at ${reset}. ${KEY_LIFTS_LIMIT}`,
        retryAfterSeconds: secondsUntil(midnight, now),
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "service_daily_limit_reached",
      message: `The service-wide daily limit for requests without an API key is reached. It resets at ${reset}. ${KEY_LIFTS_LIMIT}`,
      retryAfterSeconds: secondsUntil(midnight, now),
    },
  };
}

/** What metering a keyless request reads besides the request itself. */
export interface KeylessMeter {
  appDb: Client;
  keylessBurst: RateLimiter;
  /** the service-wide keyless daily limit, validated */
  serviceDaily: number;
}

/**
 * Counts one keyless call; an uncounted call is never served. The per-minute
 * limiter goes first: its count can't be taken back, and the daily counters
 * must not count a request it refuses. Storage and limiter errors throw.
 */
export async function meterKeyless(
  meter: KeylessMeter,
  subject: string,
  now: Date,
): Promise<Result<void, QuotaError>> {
  const burst = await meter.keylessBurst.limit({ key: subject });
  if (!burst.success) return { ok: false, error: keylessBurstRefusal() };
  return countKeylessRequest(meter.appDb, subject, meter.serviceDaily, now);
}
