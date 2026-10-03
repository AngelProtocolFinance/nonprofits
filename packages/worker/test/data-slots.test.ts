import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { claimSlotSql, flipActiveSlotSql } from "@nonprofits/db";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  buildDataSlot,
  createWorkerHarness,
  type Harness,
  issueWhitelistedKey,
  listenSeeded,
  seeded,
  serveDataSlot,
  testEnv,
} from "./harness.ts";

const RED_CROSS = "530196605";
const SLOT_B_NAME = "AMERICAN RED CROSS SLOT B";

describe("with the pointer flipped to slot b", () => {
  const server = createWorkerHarness();
  let authorization: string;

  // every lookup below follows the flip: the Worker reads the pointer on its
  // first data request, and nothing here makes one before the flip
  beforeAll(async () => {
    await listenSeeded(server);
    const { APP_DB } = await testEnv(server);
    await APP_DB.prepare(
      claimSlotSql("b", "build-b", "2026-10-03T04:00:00Z"),
    ).all();
    await buildDataSlot(
      server,
      "b",
      "build-b",
      seeded(async (db) => {
        await db
          .prepare("UPDATE orgs SET name = ?1 WHERE ein = ?2")
          .bind(SLOT_B_NAME, RED_CROSS)
          .all();
      }),
    );
    await APP_DB.prepare(
      flipActiveSlotSql("a", "build-b", "2026-10-03T05:00:00Z"),
    ).all();
    authorization = `Bearer ${(await issueWhitelistedKey(server)).key}`;
  });

  afterAll(async () => {
    await server.close();
  });

  test("a REST lookup and search read slot b", async () => {
    const lookup = await server.fetch(`/v1/orgs/${RED_CROSS}`, {
      headers: { authorization },
    });
    expect(((await lookup.json()) as { name: string }).name).toBe(SLOT_B_NAME);

    const search = await server.fetch("/v1/search?q=slot", {
      headers: { authorization },
    });
    expect(
      ((await search.json()) as { results: { ein: string }[] }).results.map(
        (r) => r.ein,
      ),
    ).toStrictEqual([RED_CROSS]);
  });

  test("an MCP lookup reads slot b", async () => {
    const client = new Client({ name: "data-slots-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        requestInit: { headers: { authorization } },
        // the client types init with node's global fetch, the harness with undici's
        fetch: (url, init) =>
          server.fetch(String(url), init as Parameters<Harness["fetch"]>[1]),
      }),
    );

    const result = await client.callTool({
      name: "lookup_nonprofit",
      arguments: { ein: RED_CROSS },
    });

    expect((result.structuredContent as { name: string }).name).toBe(
      SLOT_B_NAME,
    );
    await client.close();
  });
});

describe("with slot a serving", () => {
  const server = createWorkerHarness();

  beforeAll(async () => {
    await listenSeeded(server);
  });

  afterAll(async () => {
    await server.close();
  });

  test("a reset of the served data DB keeps keys and their usage", async () => {
    const issued = await issueWhitelistedKey(server);
    const headers = { authorization: `Bearer ${issued.key}` };
    const before = await server.fetch(`/v1/orgs/${RED_CROSS}`, { headers });
    expect(before.status).toBe(200);
    await before.body?.cancel();

    await serveDataSlot(server, "a", "seed-a", seeded());

    const after = await server.fetch(`/v1/orgs/${RED_CROSS}`, { headers });
    expect(after.status).toBe(200);
    await after.body?.cancel();
    const { APP_DB } = await testEnv(server);
    const { results } = await APP_DB.prepare(
      "SELECT requests FROM key_usage WHERE subject = ?1",
    )
      .bind(issued.id)
      .all<{ requests: number }>();
    expect(results).toStrictEqual([{ requests: 2 }]);
  });
});

describe("with no data DB ever read", () => {
  const server = createWorkerHarness();

  beforeAll(async () => {
    await listenSeeded(server);
  });

  afterAll(async () => {
    await server.close();
  });

  test("a lookup is a 503 data_unavailable while the pointer can't be read", async () => {
    const { key } = await issueWhitelistedKey(server);
    const { APP_DB } = await testEnv(server);
    await APP_DB.prepare("DROP TABLE data_generation").all();

    const response = await server.fetch(`/v1/orgs/${RED_CROSS}`, {
      headers: { authorization: `Bearer ${key}` },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "data_unavailable" });
  });
});
