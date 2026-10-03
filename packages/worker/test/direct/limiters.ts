/**
 * A Rate Limiting binding that admits every call, for tests whose requests
 * outrun a real binding's per-minute limit: a day's quota sent in one real
 * minute. The bindings themselves are covered in limits.test.ts.
 */
export const noBurstLimit: RateLimit = {
  limit: async () => ({ success: true }),
};
