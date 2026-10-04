import type { Result } from "@nonprofits/core";
import { NEVER_BUILT } from "@nonprofits/db";
import { countOf } from "./count.ts";
import { logFailure } from "./log.ts";
import { isSecretSet } from "./secret.ts";

/** `.github/workflows/import.yml`'s file name, which the dispatch endpoint takes for its id, and the branch it runs on. */
const WORKFLOW = "import.yml";
const WORKFLOW_REF = "main";

// what GitHub accepts as owner/repo; anything else would change the path
const OWNER_REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

interface FreshnessConfig {
  repo: string;
  staleAfterDays: number;
  redispatchAfterHours: number;
}

interface InvalidConfig {
  code: "invalid_config";
  message: string;
}

function invalid(message: string): Result<never, InvalidConfig> {
  return { ok: false, error: { code: "invalid_config", message } };
}

function configOf(env: Env): Result<FreshnessConfig, InvalidConfig> {
  const staleAfterDays = countOf(env.STALE_AFTER_DAYS);
  if (staleAfterDays === null) {
    return invalid("STALE_AFTER_DAYS is not a positive integer");
  }
  const redispatchAfterHours = countOf(env.REDISPATCH_AFTER_HOURS);
  if (redispatchAfterHours === null) {
    return invalid("REDISPATCH_AFTER_HOURS is not a positive integer");
  }
  if (
    typeof env.GITHUB_REPO !== "string" ||
    !OWNER_REPO.test(env.GITHUB_REPO)
  ) {
    return invalid("GITHUB_REPO is not owner/repo");
  }
  return {
    ok: true,
    value: { repo: env.GITHUB_REPO, staleAfterDays, redispatchAfterHours },
  };
}

// ?1 NEVER_BUILT, ?2 STALE_AFTER_DAYS, ?3 REDISPATCH_AFTER_HOURS; every time is
// the database's clock
const STALE =
  "(build_id = ?1 OR julianday('now') - julianday(flipped_at) > ?2)";

// a refresh is running: the build holding the claim flips or releases it
const CLAIM_HELD =
  "(claim_build_id IS NOT NULL AND julianday(claim_expires_at) > julianday('now'))";

const DISPATCHED_RECENTLY =
  "(last_dispatch_at IS NOT NULL AND (julianday('now') - julianday(last_dispatch_at)) * 24 < ?3)";

const READ_FRESHNESS_SQL = `SELECT ${STALE} AS stale, ${CLAIM_HELD} AS claim_held,
  ${DISPATCHED_RECENTLY} AS dispatched_recently, build_id, flipped_at, last_dispatch_at
FROM data_generation WHERE id = 1`;

// Stamps the dispatch before the call, and only while one is still due: of two
// runs of one cron, one dispatches. A run that dies before the answer leaves
// the status null.
const RESERVE_DISPATCH_SQL = `UPDATE data_generation
SET last_dispatch_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), last_dispatch_status = NULL
WHERE id = 1 AND ${STALE} AND NOT ${CLAIM_HELD} AND NOT ${DISPATCHED_RECENTLY}
RETURNING last_dispatch_at`;

const RECORD_DISPATCH_SQL =
  "UPDATE data_generation SET last_dispatch_status = ?1 WHERE id = 1 AND last_dispatch_at = ?2";

interface Freshness {
  stale: 0 | 1;
  claim_held: 0 | 1;
  dispatched_recently: 0 | 1;
  build_id: string;
  flipped_at: string;
  last_dispatch_at: string | null;
}

function log(level: "log" | "warn" | "error", entry: Record<string, unknown>) {
  console[level](JSON.stringify(entry));
}

/** GitHub's answer to one call: its HTTP status and, when not 2xx, the start of its body; a null status when no answer came. */
type GitHubAnswer =
  | { status: number; ok: boolean; body?: string }
  | { status: null; ok: false; cause: unknown };

async function callWorkflow(
  repo: string,
  token: string,
  action: "enable" | "dispatches",
): Promise<GitHubAnswer> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "nonprofits-worker",
  };
  const init: RequestInit =
    action === "dispatches"
      ? {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ ref: WORKFLOW_REF }),
        }
      : { method: "PUT", headers };
  let response: Response;
  try {
    response = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/${action}`,
      init,
    );
  } catch (error) {
    const cause =
      error instanceof Error ? `${error.name}: ${error.message}` : error;
    return { status: null, ok: false, cause };
  }
  if (response.ok) return { status: response.status, ok: true };
  const body = (await response.text()).slice(0, 200);
  return { status: response.status, ok: false, body };
}

/**
 * Starts the monthly import when the served build is stale, no refresh holds
 * a claim, and the last dispatch is older than `REDISPATCH_AFTER_HOURS`:
 * enables the workflow, which also brings back its schedule, then dispatches
 * it. Never throws: a failure is logged, and the next day's run decides again.
 */
export async function guardFreshness(env: Env): Promise<void> {
  try {
    const config = configOf(env);
    if (!config.ok) {
      log("error", {
        event: "import_dispatch_skipped",
        reason: config.error.code,
        detail: config.error.message,
      });
      return;
    }
    const { repo, staleAfterDays, redispatchAfterHours } = config.value;
    const params = [NEVER_BUILT, staleAfterDays, redispatchAfterHours];
    const { results } = await env.APP_DB.prepare(READ_FRESHNESS_SQL)
      .bind(...params)
      .all<Freshness>();
    const freshness = results[0];
    if (freshness === undefined) throw new Error("data_generation has no row");
    if (!freshness.stale) {
      log("log", {
        event: "data_fresh",
        buildId: freshness.build_id,
        flippedAt: freshness.flipped_at,
      });
      return;
    }
    if (freshness.claim_held) {
      log("log", { event: "import_dispatch_skipped", reason: "claim_held" });
      return;
    }
    if (freshness.dispatched_recently) {
      log("log", {
        event: "import_dispatch_skipped",
        reason: "dispatched_recently",
        lastDispatchAt: freshness.last_dispatch_at,
      });
      return;
    }
    if (!isSecretSet(env.GITHUB_DISPATCH_TOKEN)) {
      log("warn", {
        event: "import_dispatch_skipped",
        reason: "token_unset",
      });
      return;
    }
    const reserved = await env.APP_DB.prepare(RESERVE_DISPATCH_SQL)
      .bind(...params)
      .all<{ last_dispatch_at: string }>();
    const dispatchedAt = reserved.results[0]?.last_dispatch_at;
    if (dispatchedAt === undefined) {
      log("log", { event: "import_dispatch_skipped", reason: "no_longer_due" });
      return;
    }
    const record = async ({ status }: GitHubAnswer) => {
      if (status === null) return;
      await env.APP_DB.prepare(RECORD_DISPATCH_SQL)
        .bind(status, dispatchedAt)
        .all();
    };
    // GitHub disables the workflow after 60 days without repository activity, and
    // a disabled workflow isn't triggered; enabling an enabled one answers 204
    const enabled = await callWorkflow(
      repo,
      env.GITHUB_DISPATCH_TOKEN,
      "enable",
    );
    if (!enabled.ok) {
      log("error", { event: "import_enable_failed", ...enabled });
      await record(enabled);
      return;
    }
    const dispatched = await callWorkflow(
      repo,
      env.GITHUB_DISPATCH_TOKEN,
      "dispatches",
    );
    log(dispatched.ok ? "log" : "error", {
      event: "import_dispatched",
      ...dispatched,
    });
    await record(dispatched);
  } catch (error) {
    logFailure("freshness_check_failed", error);
  }
}
