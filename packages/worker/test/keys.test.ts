import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createWorkerHarness,
  type IssuedKey,
  issueKey,
  listenSeeded,
  postAdmin,
  testEnv,
} from "./harness.ts";

const server = createWorkerHarness();

beforeAll(async () => {
  await listenSeeded(server);
});

afterAll(async () => {
  await server.close();
});

describe("API key guard on GET /v1/orgs/:ein", () => {
  test("refuses a request with no key: 401 missing_api_key, saying how to send and get one", async () => {
    const response = await server.fetch("/v1/orgs/530196605");
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer realm="nonprofits"',
    );
    expect(await response.json()).toStrictEqual({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      code: "missing_api_key",
      detail:
        "No API key sent. Send one as `Authorization: Bearer <key>`. To get a key, ask the operator; self-serve signup is coming.",
    });
  });

  test.each([
    "Bearer not-a-key",
    `Bearer npk_${"a".repeat(63)}`,
    `Bearer npk_${"a".repeat(63)}_`,
    `Basic npk_${"a".repeat(64)}`,
    `npk_${"a".repeat(64)}`,
  ])(
    "refuses a malformed key (%s): 401 invalid_api_key naming the format",
    async (authorization) => {
      const response = await server.fetch("/v1/orgs/530196605", {
        headers: { authorization },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(
        'Bearer realm="nonprofits", error="invalid_token"',
      );
      expect(await response.json()).toMatchObject({
        code: "invalid_api_key",
        detail:
          "API key is malformed: expected `npk_` followed by 64 letters, sent as `Authorization: Bearer <key>`. To get a key, ask the operator; self-serve signup is coming.",
      });
    },
  );

  test("refuses a well-formed key nobody issued: 401 invalid_api_key", async () => {
    const response = await server.fetch("/v1/orgs/530196605", {
      headers: { authorization: `Bearer npk_${"Q".repeat(64)}` },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "invalid_api_key",
      detail:
        "API key not recognized: check it was copied whole. To get a key, ask the operator; self-serve signup is coming.",
    });
  });
});

describe("admin key endpoints", () => {
  test("issue a key that opens the lookup: 201 with the key, then 200 with the org", async () => {
    const created = await postAdmin(server, "/admin/keys", {
      email: "Owner@Example.org",
      name: "ci",
    });
    expect(created.status).toBe(201);
    const issued = (await created.json()) as IssuedKey;
    expect(issued).toStrictEqual({
      id: expect.any(String),
      key: expect.stringMatching(/^npk_[A-Za-z]{64}$/),
      name: "ci",
      ownerEmail: "owner@example.org",
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      expiresAt: null,
    });

    const response = await server.fetch("/v1/orgs/530196605", {
      headers: { authorization: `Bearer ${issued.key}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ein: "530196605",
      name: "AMERICAN NATIONAL RED CROSS",
    });
  });

  test("revoke a key: 200, then its next lookup is 401 revoked_api_key", async () => {
    const issued = await issueKey(server);
    const authorization = `Bearer ${issued.key}`;
    const before = await server.fetch("/v1/orgs/530196605", {
      headers: { authorization },
    });
    expect(before.status).toBe(200);

    const revoked = await postAdmin(server, `/admin/keys/${issued.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toStrictEqual({
      id: issued.id,
      status: "revoked",
    });

    const after = await server.fetch("/v1/orgs/530196605", {
      headers: { authorization },
    });
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toBe(
      'Bearer realm="nonprofits", error="invalid_token"',
    );
    expect(await after.json()).toMatchObject({
      code: "revoked_api_key",
      detail:
        "API key has been revoked. To get a key, ask the operator; self-serve signup is coming.",
    });
  });

  test("stores keys hashed only: the key table holds the key's row but not its secret", async () => {
    const issued = await issueKey(server);
    const { DB } = await testEnv(server);
    const { results } = await DB.prepare("SELECT * FROM apikey").all();
    const table = JSON.stringify(results);
    expect(table).toContain(issued.id);
    expect(table).not.toContain(issued.key);
    expect(table).not.toContain(issued.key.slice("npk_".length));
  });

  test("logs each refused key as one info line without key material, and no base-URL warning", async () => {
    const revoked = await issueKey(server);
    await postAdmin(server, `/admin/keys/${revoked.id}/revoke`);
    const unknown = `npk_${"Z".repeat(64)}`;
    const before = server.getLogs().length;

    for (const key of [unknown, revoked.key]) {
      await server.fetch("/v1/orgs/530196605", {
        headers: { authorization: `Bearer ${key}` },
      });
    }

    const refusals = server
      .getLogs()
      .slice(before)
      .map(({ level, message }) => ({ level, message }));
    expect(refusals).toStrictEqual([
      { level: "info", message: "api key refused: INVALID_API_KEY" },
      { level: "info", message: "api key refused: KEY_DISABLED" },
    ]);
    expect(JSON.stringify(server.getLogs())).not.toMatch(/Base URL is not set/);
  });

  test("revoking an id that was never issued is 404 key_not_found", async () => {
    const response = await postAdmin(server, "/admin/keys/no-such-key/revoke");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "key_not_found" });
  });

  test("revoking an id that isn't valid percent-encoding is 400 invalid_request, not a bare 500", async () => {
    const response = await postAdmin(server, "/admin/keys/%E0%A4%A/revoke");
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
  });

  test.each([
    ["no admin token", {}],
    ["a wrong admin token", { authorization: "Bearer wrong-token" }],
  ])("refuse %s with 401 admin_unauthorized", async (_, headers) => {
    for (const [path, body] of [
      ["/admin/keys", { email: "owner@example.org" }],
      ["/admin/keys/some-id/revoke", {}],
    ] as const) {
      const response = await server.fetch(path, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        code: "admin_unauthorized",
        detail: "Admin endpoints need `Authorization: Bearer <ADMIN_TOKEN>`.",
      });
    }
  });
});
