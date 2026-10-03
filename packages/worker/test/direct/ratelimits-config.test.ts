import { expect, test } from "vitest";
import { experimental_readRawConfig } from "wrangler";
import {
  BURST_PERIOD_SECONDS,
  DEFAULT_LIMITS,
  KEYED_REQUESTS_PER_MINUTE,
  KEYLESS_LIMITS,
  KEYLESS_MCP_REQUESTS_PER_MINUTE,
} from "../../src/quota.ts";

interface RateLimitBinding {
  name: string;
  simple: { limit: number; period: number };
}

test("each Rate Limiting binding in wrangler.jsonc counts the limit and period quota.ts tells clients", () => {
  const { rawConfig } = experimental_readRawConfig({
    config: new URL("../../wrangler.jsonc", import.meta.url).pathname,
  });
  const configured = Object.fromEntries(
    (rawConfig.ratelimits as RateLimitBinding[]).map((binding) => [
      binding.name,
      binding.simple,
    ]),
  );

  expect(configured).toStrictEqual({
    KEY_BURST_LIMITER: {
      limit: DEFAULT_LIMITS.perMinute,
      period: BURST_PERIOD_SECONDS,
    },
    KEYLESS_BURST_LIMITER: {
      limit: KEYLESS_LIMITS.perMinute,
      period: BURST_PERIOD_SECONDS,
    },
    KEYED_REQUEST_LIMITER: {
      limit: KEYED_REQUESTS_PER_MINUTE,
      period: BURST_PERIOD_SECONDS,
    },
    KEYLESS_MCP_LIMITER: {
      limit: KEYLESS_MCP_REQUESTS_PER_MINUTE,
      period: BURST_PERIOD_SECONDS,
    },
  });
});
