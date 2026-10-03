/**
 * Node has no Cache API: a `caches` that never holds a search, for direct
 * tests that reach one. The cache itself is covered in workerd by
 * search.test.ts.
 */
export const noCaches = {
  open: async () => ({
    match: async () => undefined,
    put: async () => {},
  }),
} as unknown as CacheStorage;
