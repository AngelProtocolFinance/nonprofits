import type { OrgSearchRecord } from "@nonprofits/core";
import { D1OrgSearcher } from "./d1-org-searcher.ts";
import type { ServedData } from "./data-db.ts";

/** A sealed build's names never change, so its results only age out; a new build is a new key. */
const TTL_SECONDS = 60 * 60;

/**
 * Searches the served data DB through this data center's cache, keyed by the
 * build it holds: a costly search (a word in most names) repeated within the
 * hour reads no rows instead of ranking again on the single thread every
 * lookup shares.
 */
export async function cachedSearch(
  { db, buildId }: ServedData,
  words: string[],
  limit: number,
  onRowsRead: (rows: number) => void,
): Promise<{ records: OrgSearchRecord[]; cached: boolean }> {
  // FTS matches words case-insensitively, so their case is not part of the key
  const query = new URLSearchParams({
    limit: String(limit),
    q: words.map((word) => word.toLowerCase()).join(" "),
  });
  const key = `https://org-search.invalid/${encodeURIComponent(buildId)}?${query}`;
  const cache = await caches.open("org-search");
  const hit = await cache.match(key);
  if (hit !== undefined) {
    return { records: await hit.json<OrgSearchRecord[]>(), cached: true };
  }
  const records = await new D1OrgSearcher(db, onRowsRead).search(words, limit);
  await cache.put(
    key,
    Response.json(records, {
      headers: { "cache-control": `max-age=${TTL_SECONDS}` },
    }),
  );
  return { records, cached: false };
}
