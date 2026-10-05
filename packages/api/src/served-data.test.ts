import { switchServedDatabase } from "@nonprofits/db";
import { dataDbFixture, type LocalDb } from "@nonprofits/db/fixture";
import { afterEach, describe, expect, test } from "vitest";
import { POINTER_TTL_MS } from "./data-db.ts";
import {
  freshClient,
  type TestApi,
  type TestApiOptions,
  testApi,
  usageRows,
} from "./test-support.ts";

let api: TestApi;
const extra: LocalDb[] = [];

async function start(options?: TestApiOptions) {
  api = await testApi(options);
  return api;
}

afterEach(async () => {
  await api.dispose();
  for (const db of extra.splice(0)) await db.dispose();
});

function lookup(ein = "530196605") {
  return api.app.request(`/v1/orgs/${ein}`, { headers: freshClient() });
}

/** Points the pointer from the fixture at `to`, holding `buildId`. */
async function serve(to: { name: string; url: string }, buildId: string) {
  const { switched } = await switchServedDatabase(api.appDb.client, {
    expected: "nonprofits-fixture",
    to,
    buildId,
  });
  expect(switched).toBe(true);
}

const DATA_FAILED = {
  type: "about:blank",
  title: "Service Unavailable",
  status: 503,
  code: "data_unavailable",
  detail:
    "The org data store failed to answer; nothing is wrong with your request. Retry shortly.",
};

describe("the served data database", () => {
  test("before the first build is served, a request is 503 data_unavailable saying so, and isn't counted", async () => {
    await start({ serve: false });

    const response = await lookup();

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await response.json()).toStrictEqual({
      type: "about:blank",
      title: "Service Unavailable",
      status: 503,
      code: "data_unavailable",
      detail:
        "No org data is loaded yet: the service is waiting for its first IRS import. Nothing is wrong with your request, and it wasn't counted.",
    });
    expect(await usageRows(api)).toBe(0);
  });

  test("a pointer naming an unreachable database is 503 data_unavailable, and the request isn't counted", async () => {
    await start();
    await serve(
      { name: "gone", url: "http://127.0.0.1:9" },
      "20261010T030000Z",
    );

    const response = await lookup();

    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual(DATA_FAILED);
    expect(await usageRows(api)).toBe(0);
  });

  test("a pointer naming a database that doesn't hold its build is 503 data_unavailable", async () => {
    await start();
    const other = await dataDbFixture("20261010T030000Z");
    extra.push(other);
    await serve({ name: "mislabeled", url: other.url }, "20261110T030000Z");

    const response = await search();

    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual(DATA_FAILED);
  });

  test("a read that fails on the served database is 503 data_unavailable, not a bare 500", async () => {
    await start({
      fill: async (data) => {
        await data.execute("DROP TABLE programs");
      },
    });

    const response = await lookup();

    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual(DATA_FAILED);
  });

  test("a switch to a new build is served once the pointer is read again, within 30 s", async () => {
    await start();
    const next = await dataDbFixture("20261010T030000Z");
    extra.push(next);
    await next.client.execute(
      "UPDATE orgs SET name = 'AMERICAN RED CROSS' WHERE ein = '530196605'",
    );
    expect(await nameOf(await lookup())).toBe("AMERICAN NATIONAL RED CROSS");

    await serve({ name: "nonprofits-next", url: next.url }, "20261010T030000Z");
    api.clock.advance(POINTER_TTL_MS - 1);
    expect(await nameOf(await lookup())).toBe("AMERICAN NATIONAL RED CROSS");
    api.clock.advance(1);

    expect(await nameOf(await lookup())).toBe("AMERICAN RED CROSS");
  });
});

function search() {
  return api.app.request("/v1/search?q=red%20cross", {
    headers: freshClient(),
  });
}

async function nameOf(response: Response): Promise<unknown> {
  expect(response.status).toBe(200);
  return ((await response.json()) as { name: unknown }).name;
}
