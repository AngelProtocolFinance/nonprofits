import { afterEach, describe, expect, test } from "vitest";
import {
  seedUsage,
  type TestApi,
  type TestApiOptions,
  testApi,
  usageRows,
} from "./test-support.ts";

let api: TestApi;

async function start(options?: TestApiOptions) {
  api = await testApi(options);
  return api;
}

afterEach(async () => {
  await api.dispose();
});

const MINUTE_MS = 60_000;

function lookupFrom(headers: Record<string, string>, ein = "530196605") {
  return api.app.request(`/v1/orgs/${ein}`, { headers });
}

const from = (ip: string) => ({ "x-real-ip": ip });

describe("keyless quota", () => {
  test("an IP gets 5 requests a UTC day; the 6th is 429 with Retry-After to UTC midnight, and another IP is still served", async () => {
    await start();
    api.clock.set("2026-10-05T22:00:00Z");
    for (let i = 1; i <= 5; i++) {
      const response = await lookupFrom(from("203.0.113.10"));
      expect(response.status, `request ${i}`).toBe(200);
      api.clock.advance(MINUTE_MS);
    }

    const sixth = await lookupFrom(from("203.0.113.10"));

    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("content-type")).toBe("application/problem+json");
    expect(sixth.headers.get("retry-after")).toBe("6900");
    expect(await sixth.json()).toStrictEqual({
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      code: "daily_quota_exceeded",
      detail:
        "Requests without an API key are limited to 5 requests a UTC day per IP address, and this address has used them. They reset at 2026-10-06T00:00:00Z (UTC midnight). An API key lifts this limit: ask the operator for one.",
    });
    expect((await lookupFrom(from("203.0.113.11"))).status).toBe(200);
  });

  test("the next UTC day opens an IP's quota again", async () => {
    await start();
    api.clock.set("2026-10-05T23:50:00Z");
    for (let i = 1; i <= 5; i++) {
      await lookupFrom(from("203.0.113.12"));
      api.clock.advance(MINUTE_MS);
    }
    expect((await lookupFrom(from("203.0.113.12"))).status).toBe(429);

    api.clock.set("2026-10-06T00:00:00Z");

    expect((await lookupFrom(from("203.0.113.12"))).status).toBe(200);
  });

  test("an IP's 2nd request inside a minute is 429 from the per-minute limiter; another IP is served, and so is the IP the next minute", async () => {
    await start();
    api.clock.set("2026-10-05T12:00:10Z");
    expect((await lookupFrom(from("203.0.113.30"))).status).toBe(200);

    const second = await lookupFrom(from("203.0.113.30"));

    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("60");
    expect(await second.json()).toMatchObject({
      code: "per_minute_limit_exceeded",
      detail:
        "Requests without an API key are limited to 1 request per minute per IP address. Retry in 60 seconds. An API key lifts this limit: ask the operator for one.",
    });
    expect((await lookupFrom(from("203.0.113.31"))).status).toBe(200);
    api.clock.set("2026-10-05T12:01:00Z");
    expect((await lookupFrom(from("203.0.113.30"))).status).toBe(200);
  });

  test("a request refused by the per-minute limiter isn't counted toward the day", async () => {
    await start();
    for (let i = 1; i <= 5; i++) {
      expect((await lookupFrom(from("203.0.113.32"))).status).toBe(200);
      expect((await lookupFrom(from("203.0.113.32"))).status).toBe(429);
      api.clock.advance(MINUTE_MS);
    }
    expect(await countedPerClient()).toStrictEqual([5]);
  });

  test("a client-set IP header beside the platform's is ignored: the request counts as the platform's IP", async () => {
    await start();
    expect((await lookupFrom(from("203.0.113.40"))).status).toBe(200);

    const spoofed = await lookupFrom({
      "x-real-ip": "203.0.113.40",
      "x-forwarded-for": "198.51.100.1",
      "x-vercel-forwarded-for": "198.51.100.2",
      "cf-connecting-ip": "198.51.100.3",
    });

    expect(spoofed.status).toBe(429);
  });

  test("keyless IPv6 callers are counted per /64: another address in the /64 shares the minute, another /64 doesn't", async () => {
    await start();
    expect((await lookupFrom(from("2001:db8:1:2::a"))).status).toBe(200);
    expect(
      (await lookupFrom(from("2001:0db8:0001:0002:ffff:0:0:b"))).status,
    ).toBe(429);
    expect((await lookupFrom(from("2001:db8:1:3::a"))).status).toBe(200);
  });

  test("requests with no client IP are counted together, not let through", async () => {
    await start();
    expect((await lookupFrom({})).status).toBe(200);
    expect((await lookupFrom({})).status).toBe(429);
  });

  test("an invalid EIN or search isn't counted: the IP's one request a minute is still served after them", async () => {
    await start();
    const ip = from("203.0.113.50");
    expect((await lookupFrom(ip, "12")).status).toBe(400);
    expect(
      (await api.app.request("/v1/search?q=x", { headers: ip })).status,
    ).toBe(400);
    expect(
      (await api.app.request("/v1/search?q=red&limit=0", { headers: ip }))
        .status,
    ).toBe(400);

    expect((await lookupFrom(ip)).status).toBe(200);
    expect((await lookupFrom(ip)).status).toBe(429);
  });

  test("search and lookup count against the same per-IP day", async () => {
    await start();
    const ip = from("203.0.113.60");
    for (let i = 1; i <= 3; i++) {
      expect((await lookupFrom(ip)).status).toBe(200);
      api.clock.advance(MINUTE_MS);
    }
    const searchRed = () =>
      api.app.request("/v1/search?q=red%20cross", { headers: ip });
    expect((await searchRed()).status).toBe(200);
    api.clock.advance(MINUTE_MS);
    expect((await searchRed()).status).toBe(200);
    api.clock.advance(MINUTE_MS);

    const sixth = await searchRed();

    expect(await sixth.json()).toMatchObject({
      code: "daily_quota_exceeded",
    });
  });

  test("a request is counted under a keyed hash of its IP; no usage row holds the IP itself", async () => {
    await start();
    await lookupFrom(from("198.51.100.77"));

    const rows = await api.appDb.client.execute(
      "SELECT subject, requests FROM key_usage WHERE subject LIKE 'ip:%'",
    );
    expect(rows.rows.map((row) => ({ ...row }))).toMatchObject([
      { subject: expect.stringMatching(/^ip:[0-9a-f]{64}$/), requests: 1 },
    ]);
    const every = await api.appDb.client.execute("SELECT * FROM key_usage");
    expect(JSON.stringify(every.rows)).not.toContain("198.51.100.77");
  });

  test("at the service-wide keyless daily limit the next request is 429 saying a key lifts it, from any IP", async () => {
    await start({ vars: { SERVICE_KEYLESS_DAILY_LIMIT: "2" } });
    await lookupFrom(from("203.0.113.70"));
    await lookupFrom(from("203.0.113.71"));

    const third = await lookupFrom(from("203.0.113.72"));

    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("43200");
    expect(await third.json()).toMatchObject({
      code: "service_daily_limit_reached",
      detail:
        "The service-wide daily limit for requests without an API key is reached. It resets at 2026-10-06T00:00:00Z (UTC midnight). An API key lifts this limit: ask the operator for one.",
    });
  });

  test("with the service-wide limit unset, the default ceiling applies: its last request is served and the next is 429", async () => {
    await start({ vars: { SERVICE_KEYLESS_DAILY_LIMIT: undefined } });
    await seedUsage(api, "*:keyless", "2026-10-05", 199);

    expect((await lookupFrom(from("203.0.113.76"))).status).toBe(200);
    const next = await lookupFrom(from("203.0.113.77"));

    expect(next.status).toBe(429);
    expect(await next.json()).toMatchObject({
      code: "service_daily_limit_reached",
    });
  });

  test.each([
    ["not a number", "many"],
    ["zero", "0"],
    ["fractional", "2.5"],
    ["empty", ""],
  ])(
    "a service-wide limit that is %s refuses requests unavailable (503), never unlimited",
    async (_, value) => {
      await start({ vars: { SERVICE_KEYLESS_DAILY_LIMIT: value } });

      const response = await lookupFrom(from("203.0.113.73"));

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "auth_unavailable",
      });
    },
  );

  test.each([
    ["unset", undefined],
    ["a placeholder", "replace-with-32-plus-random-characters"],
    ["too short", "short"],
  ])(
    "with IP_HASH_SECRET %s, requests are refused unavailable (503) and not counted",
    async (_, secret) => {
      await start({ vars: { IP_HASH_SECRET: secret } });

      const response = await lookupFrom(from("203.0.113.74"));

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "auth_unavailable",
        detail:
          "Requests without an API key can't be served right now. Retry later, or send an API key.",
      });
      expect(await usageRows(api)).toBe(0);
    },
  );
});

/** Each client's counted requests, as `key_usage` holds them. */
async function countedPerClient(): Promise<unknown[]> {
  const rows = await api.appDb.client.execute(
    "SELECT requests FROM key_usage WHERE subject LIKE 'ip:%'",
  );
  return rows.rows.map((row) => row.requests);
}
