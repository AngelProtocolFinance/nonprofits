import { checkRateLimit } from "@vercel/firewall";
import type { AppDeps } from "./app.ts";
import type { RateLimiter } from "./limiter.ts";

/** The app's per-minute limiters. */
export type Limiters = Pick<
  AppDeps,
  "keylessBurst" | "keyBurst" | "keyedRequests" | "keylessMcpRequests"
>;

/**
 * The Rate limit ID of each limiter's `@vercel/firewall` rule in the
 * project's Firewall. A rule's window and request limit are set there, not
 * here: 60 seconds, and the limit `quota.ts` names for that limiter.
 */
export const FIREWALL_RATE_LIMIT_IDS = {
  keylessBurst: "keyless-burst",
  keyBurst: "key-burst",
  keyedRequests: "keyed-requests",
  keylessMcpRequests: "keyless-mcp-requests",
} as const satisfies Record<keyof Limiters, string>;

/** One request counted against `rateLimitKey`'s bucket in the rule `rateLimitId`, as `checkRateLimit` answers. */
export type FirewallCheck = (
  rateLimitId: string,
  options: { rateLimitKey: string },
) => Promise<{ rateLimited: boolean; error?: "not-found" | "blocked" }>;

/**
 * `checkRateLimit`, refused where it would pass a request unasked: outside
 * `NODE_ENV=production` the SDK answers "not limited" without calling the
 * Firewall. Given no request, it reads the invocation's headers from Vercel's
 * request context, and throws where there is none.
 */
async function sdkCheck(
  rateLimitId: string,
  options: { rateLimitKey: string },
): ReturnType<FirewallCheck> {
  if (process.env.NODE_ENV !== "production") {
    throw new Error(
      `rate limit ${rateLimitId}: NODE_ENV is not "production", where @vercel/firewall skips the check`,
    );
  }
  return checkRateLimit(rateLimitId, options);
}

/**
 * A limiter whose count is kept by the Vercel Firewall rule `rateLimitId`,
 * bucketed by the `key` it is given. A rule that isn't published, a check the
 * Firewall blocks, or a failed call throws: the caller refuses the request.
 */
export function firewallRateLimiter(
  rateLimitId: string,
  check: FirewallCheck = sdkCheck,
): RateLimiter {
  return {
    async limit({ key }) {
      const { rateLimited, error } = await check(rateLimitId, {
        rateLimitKey: key,
      });
      if (error !== undefined) {
        throw new Error(`rate limit ${rateLimitId}: ${error}`);
      }
      return { success: !rateLimited };
    },
  };
}

/** The four limiters a deployment on Vercel serves with, each on its own Firewall rule. */
export function firewallLimiters(check: FirewallCheck = sdkCheck): Limiters {
  const on = (limiter: keyof Limiters) =>
    firewallRateLimiter(FIREWALL_RATE_LIMIT_IDS[limiter], check);
  return {
    keylessBurst: on("keylessBurst"),
    keyBurst: on("keyBurst"),
    keyedRequests: on("keyedRequests"),
    keylessMcpRequests: on("keylessMcpRequests"),
  };
}
