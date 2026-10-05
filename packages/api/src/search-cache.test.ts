import type { Client, InStatement } from "@libsql/client";
import type { OrgSearchResponse } from "@nonprofits/core";
import { switchServedDatabase } from "@nonprofits/db";
import { dataDbFixture, type LocalDb } from "@nonprofits/db/fixture";
import { afterEach, describe, expect, test, vi } from "vitest";
import { POINTER_TTL_MS } from "./data-db.ts";
import { vercelSearchCache } from "./search-cache.ts";
import {
  freshClient,
  insertKey,
  seedUsage,
  type TestApi,
  type TestApiOptions,
  testApi,
} from "./test-support.ts";

let api: TestApi;
const extra: LocalDb[] = [];
/** Name searches run on any data database the app opened. */
let searchesRun = 0;

const sqlOf = (statement: InStatement) =>
  typeof statement === "string" ? statement : statement.sql;

/** `db`, counting each batch that ranks names on it. */
function countingSearches(db: Client): Client {
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch") {
        return (statements: InStatement[], mode?: "read" | "write") => {
          if (statements.some((s) => sqlOf(s).includes("orgs_fts MATCH"))) {
            searchesRun += 1;
          }
          return target.batch(statements, mode);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function start(options: TestApiOptions = {}) {
  searchesRun = 0;
  api = await testApi({ dataDbAs: countingSearches, ...options });
  return api;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await api.dispose();
  for (const db of extra.splice(0)) await db.dispose();
});

/** The requests `key_usage` counts for `subject` on the test clock's first day. */
async function countedToday(subject: string): Promise<number> {
  const rows = await api.appDb.client.execute({
    sql: "SELECT requests FROM key_usage WHERE subject = ?1 AND day = '2026-10-05'",
    args: [subject],
  });
  return Number(rows.rows[0]?.requests ?? 0);
}

function searchAs(authorization: string, query = "q=red%20cross") {
  return api.app.request(`/v1/search?${query}`, {
    headers: { ...freshClient(), authorization },
  });
}

describe("a repeated search", () => {
  test("is answered without ranking again, and still counts against the key's daily quota", async () => {
    await start();
    const { id, key } = await insertKey(api);
    await seedUsage(api, id, "2026-10-05", 48);

    const first = await searchAs(`Bearer ${key}`);
    const second = await searchAs(`Bearer ${key}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toStrictEqual(await first.json());
    expect(searchesRun).toBe(1);
    expect(await countedToday(id)).toBe(50);
    expect((await searchAs(`Bearer ${key}`)).status).toBe(429);
  });

  test("from a bad key is 401 though a good key's identical search is cached", async () => {
    await start();
    const { key } = await insertKey(api);
    expect((await searchAs(`Bearer ${key}`)).status).toBe(200);

    const response = await searchAs(`Bearer npk_${"Q".repeat(64)}`);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "invalid_api_key" });
    expect(searchesRun).toBe(1);
  });

  test("after the pointer switches to a new build ranks again on it", async () => {
    await start();
    const { key } = await insertKey(api);
    expect((await searchAs(`Bearer ${key}`)).status).toBe(200);
    const next = await dataDbFixture("20261010T030000Z");
    extra.push(next);
    await switchServedDatabase(api.appDb.client, {
      expected: "nonprofits-fixture",
      to: { name: "nonprofits-next", url: next.url },
      buildId: "20261010T030000Z",
    });
    api.clock.advance(POINTER_TTL_MS);

    const response = await searchAs(`Bearer ${key}`);

    expect(response.status).toBe(200);
    expect(searchesRun).toBe(2);
  });

  test("an hour later ranks again", async () => {
    await start();
    const { key } = await insertKey(api);
    expect((await searchAs(`Bearer ${key}`)).status).toBe(200);
    api.clock.advance(60 * 60 * 1000 - 1);
    expect((await searchAs(`Bearer ${key}`)).status).toBe(200);
    expect(searchesRun).toBe(1);

    api.clock.advance(1);

    expect((await searchAs(`Bearer ${key}`)).status).toBe(200);
    expect(searchesRun).toBe(2);
  });

  test("in other letter case is answered from the cache, at another page size ranks again", async () => {
    await start();
    const { key } = await insertKey(api);
    expect((await searchAs(`Bearer ${key}`, "q=red%20cross")).status).toBe(200);

    expect((await searchAs(`Bearer ${key}`, "q=RED%20Cross")).status).toBe(200);
    expect(searchesRun).toBe(1);
    const fewer = await searchAs(`Bearer ${key}`, "q=red%20cross&limit=1");

    expect(fewer.status).toBe(200);
    expect(searchesRun).toBe(2);
    expect((await fewer.json()) as OrgSearchResponse).toMatchObject({
      limit: 1,
      results: [{ ein: "530196605" }],
    });
  });
});

describe("a search cache that fails", () => {
  test("is a miss: the search is ranked and answered", async () => {
    const unreachable = async () => {
      throw new Error("runtime cache unreachable");
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await start({ searchCache: { get: unreachable, set: unreachable } });
    const { key } = await insertKey(api);

    const response = await searchAs(`Bearer ${key}`);

    expect(response.status).toBe(200);
    expect((await response.json()) as OrgSearchResponse).toMatchObject({
      results: [{ ein: "530196605" }],
    });
    expect(searchesRun).toBe(1);
    expect(
      logged.mock.calls.map(([line]) => JSON.parse(String(line)).event),
    ).toStrictEqual(["search_cache_unavailable", "search_cache_unavailable"]);
  });
});

describe("the Vercel Runtime Cache", () => {
  test("keeps apart two keys its default 32-bit key hash maps to one entry", async () => {
    // off Vercel, `getCache` falls back to an in-memory cache, and says so
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cache = vercelSearchCache();

    await cache.set("zyzf qeij", ["first"], { ttl: 60 });

    expect(await cache.get("zyzf qeij")).toStrictEqual(["first"]);
    expect(await cache.get("jiwf bvdj")).toBeNull();
  });
});
