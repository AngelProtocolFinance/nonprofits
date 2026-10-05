/**
 * A per-minute limiter, shaped like Cloudflare's Rate Limiting binding: one
 * call counts one request against `key`, and `success` is false once `key`
 * is over its limit for the current period.
 */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * A fixed-window limiter held in this process's memory: `limit` calls per key
 * in each `periodSeconds` window of `now`'s clock. Every instance counts on
 * its own, so it limits a deployment only while one process serves it.
 */
export function memoryRateLimiter({
  limit,
  periodSeconds,
  now,
}: {
  limit: number;
  periodSeconds: number;
  now: () => Date;
}): RateLimiter {
  const periodMs = periodSeconds * 1000;
  let window = Number.NaN;
  let counts = new Map<string, number>();
  return {
    async limit({ key }) {
      const current = Math.floor(now().getTime() / periodMs);
      // a new window drops every count, so the map holds one window's keys
      if (current !== window) {
        window = current;
        counts = new Map();
      }
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= limit };
    },
  };
}
