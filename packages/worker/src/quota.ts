import type { Result } from "@nonprofits/core";

export interface Limits {
  daily: number;
  perMinute: number;
}

export type Tier = "default" | "whitelisted";

/** A key with no `key_limits` row. Its per-minute limit is enforced by the Rate Limiting binding, not here. */
export const DEFAULT_LIMITS: Limits = { daily: 50, perMinute: 10 };

/** A key's tier and limits from its `key_limits` columns, both null when it has no row. */
export function limitsOf(
  daily: number | null,
  perMinute: number | null,
): { tier: Tier; limits: Limits } {
  return daily === null || perMinute === null
    ? { tier: "default", limits: DEFAULT_LIMITS }
    : { tier: "whitelisted", limits: { daily, perMinute } };
}

/** A key over one of its limits: a 429 with `Retry-After: retryAfterSeconds`. */
export type QuotaError = {
  code: "daily_quota_exceeded" | "per_minute_limit_exceeded";
  message: string;
  retryAfterSeconds: number;
};

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
  AND (?5 IS NULL OR excluded.minute > minute OR minute_requests < ?5)
RETURNING requests`;

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

/**
 * Counts one request against `subject`'s daily quota, and against `perMinute`
 * when it is given (null: some other guard owns the per-minute limit).
 * Writes one `key_usage` row when admitted and none when refused. D1 errors throw.
 */
export async function countRequest(
  db: D1Database,
  subject: string,
  limits: { daily: number; perMinute: number | null },
  now: Date,
): Promise<Result<void, QuotaError>> {
  const day = utcDay(now);
  const minute = Math.floor(now.getTime() / MINUTE_MS);
  const counted = await db
    .prepare(COUNT_SQL)
    .bind(subject, day, minute, limits.daily, limits.perMinute)
    .all();
  if (counted.results.length > 0) return { ok: true, value: undefined };

  if (limits.perMinute !== null) {
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
  }
  const midnight = Date.parse(`${day}T00:00:00Z`) + DAY_MS;
  return {
    ok: false,
    error: {
      code: "daily_quota_exceeded",
      message: `This key's daily quota of ${requests(limits.daily)} is used up. It resets at ${instant(midnight)} (UTC midnight).`,
      retryAfterSeconds: secondsUntil(midnight, now),
    },
  };
}
