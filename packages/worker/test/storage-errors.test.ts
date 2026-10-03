import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createWorkerHarness,
  issueWhitelistedKey,
  listenSeeded,
  testEnv,
} from "./harness.ts";

const server = createWorkerHarness();
let authorization: string;

beforeAll(async () => {
  await listenSeeded(server);
  authorization = `Bearer ${(await issueWhitelistedKey(server)).key}`;
});

afterAll(async () => {
  await server.close();
});

const UNAVAILABLE = {
  type: "about:blank",
  title: "Service Unavailable",
  status: 503,
  code: "data_unavailable",
  detail:
    "The org data store failed to answer; nothing is wrong with your request. Retry shortly.",
};

describe("a D1 failure behind a data read", () => {
  test("answers an uncached search with a 503 problem, not a bare 500", async () => {
    const { DATA_DB_A } = await testEnv(server);
    const before = await server.fetch("/v1/search?q=red%20cross", {
      headers: { authorization },
    });
    expect(before.status).toBe(200);
    await DATA_DB_A.batch([DATA_DB_A.prepare("DROP TABLE orgs_fts")]);

    // a search not yet cached: the cache answers a repeat without D1
    const response = await server.fetch("/v1/search?q=national%20red%20cross", {
      headers: { authorization },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await response.json()).toStrictEqual(UNAVAILABLE);
  });

  test("answers a lookup with a 503 problem, not a bare 500", async () => {
    const { DATA_DB_A } = await testEnv(server);
    const before = await server.fetch("/v1/orgs/530196605", {
      headers: { authorization },
    });
    expect(before.status).toBe(200);
    await DATA_DB_A.batch([DATA_DB_A.prepare("DROP TABLE programs")]);

    const response = await server.fetch("/v1/orgs/530196605", {
      headers: { authorization },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual(UNAVAILABLE);
  });
});
