/**
 * A Rate Limiting binding that admits every call, for tests whose requests
 * outrun a real binding's per-minute limit: a day's quota sent in one real
 * minute. A real binding is tried once per limiter: limits.test.ts and,
 * through the Worker, keys.test.ts and mcp.test.ts.
 */
export const noBurstLimit: RateLimit = {
  limit: async () => ({ success: true }),
};

/**
 * A Rate Limiting binding that counts per key and refuses a key's calls past
 * `limit`, with no clock: the binding's count is what a test about a refusal
 * path asserts, and a real one's depends on the minute it runs in. `keys`
 * lists the key of every call, in order.
 */
export function countingLimiter(limit: number): RateLimit & { keys: string[] } {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }) => {
      keys.push(key);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= limit };
    },
  };
}
