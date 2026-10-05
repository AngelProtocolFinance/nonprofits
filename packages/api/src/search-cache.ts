import { createHash } from "node:crypto";
import type { OrgSearchRecord } from "@nonprofits/core";
import { getCache } from "@vercel/functions";
import type { ServedData } from "./data-db.ts";
import { logFailure } from "./log.ts";
import { SEARCH_RECORD_VERSION, searchNames } from "./org-searcher.ts";

/** A build's names never change, so its results only age out; a new build is a new key. */
const TTL_SECONDS = 60 * 60;

/** Where repeated searches are answered from. Shaped as Vercel's `RuntimeCache` is, so it passes as one. */
export interface SearchCache {
  /** The value set under `key`, or null once it has expired or was never set. */
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options: { ttl: number }): Promise<void>;
}

/**
 * The searcher's records for `words` at `limit` on the served build, from
 * `cache` when the same search set them within the hour: a word in most names
 * ranks up to 10,000 candidates, each a few Turso rows read. The cache failing
 * to answer is a miss, and failing to store is logged: either way the search
 * is answered.
 */
export async function cachedSearch(
  cache: SearchCache,
  { client, buildId }: ServedData,
  words: string[],
  limit: number,
): Promise<OrgSearchRecord[]> {
  // FTS matches words case-insensitively, so their case is not part of the key
  const key = JSON.stringify([
    SEARCH_RECORD_VERSION,
    buildId,
    limit,
    words.map((word) => word.toLowerCase()),
  ]);
  const hit = await cache.get(key).catch((error: unknown) => {
    logFailure("search_cache_unavailable", error);
    return null;
  });
  // only `set` below writes a key holding this version
  if (hit !== null) return hit as OrgSearchRecord[];
  const records = await searchNames(client, words, limit);
  await cache
    .set(key, records, { ttl: TTL_SECONDS })
    .catch((error: unknown) => logFailure("search_cache_unavailable", error));
  return records;
}

/**
 * A cache held in this process's memory, on `now`'s clock. Every instance
 * caches on its own and keeps each entry until it is read past its TTL: for
 * local dev and tests, not a deployment.
 */
export function memorySearchCache(now: () => Date): SearchCache {
  const entries = new Map<string, { value: unknown; expiresAt: number }>();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return null;
      if (now().getTime() >= entry.expiresAt) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, { ttl }) {
      entries.set(key, { value, expiresAt: now().getTime() + ttl * 1000 });
    },
  };
}

/**
 * Vercel's Runtime Cache: on Pro, one per project, region and environment,
 * shared by every function instance there. Its default key hash is 32 bits, which distinct
 * searches would collide on, so keys are hashed with SHA-256.
 */
export function vercelSearchCache(): SearchCache {
  return getCache({
    namespace: "org-search",
    keyHashFunction: (key) => createHash("sha256").update(key).digest("hex"),
  });
}
