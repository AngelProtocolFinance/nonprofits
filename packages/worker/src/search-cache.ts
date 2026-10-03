import type { OrgSearchRecord } from "@nonprofits/core";
import { READ_DATA_META_SQL } from "@nonprofits/db";
import { D1OrgSearcher } from "./d1-org-searcher.ts";

/** A sealed build's names never change, so its results only age out; a new build is a new key. */
const TTL_SECONDS = 60 * 60;

/**
 * Searches the data DB `db` through this data center's cache, keyed by the
 * build `db` holds: a costly search (a word in most names) repeated within the
 * hour reads D1's one `data_meta` row instead of ranking again on the single
 * thread every lookup shares.
 */
export async function cachedSearch(
  db: D1Database,
  words: string[],
  limit: number,
  onRowsRead: (rows: number) => void,
): Promise<{ records: OrgSearchRecord[]; cached: boolean }> {
  const { results, meta } = await db
    .prepare(READ_DATA_META_SQL)
    .all<{ build_id: string }>();
  onRowsRead(meta.rows_read);
  const build = results[0]?.build_id;
  if (build === undefined) throw new Error("data_meta has no row");

  // FTS matches words case-insensitively, so their case is not part of the key
  const query = new URLSearchParams({
    limit: String(limit),
    q: words.map((word) => word.toLowerCase()).join(" "),
  });
  const key = `https://org-search.invalid/${encodeURIComponent(build)}?${query}`;
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
