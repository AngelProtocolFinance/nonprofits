import type { Client } from "@libsql/client";
import type { Result } from "@nonprofits/core";
import { NEVER_BUILT } from "@nonprofits/db";
import { countOf } from "./count.ts";
import type { ApiVars } from "./handlers.ts";
import { logFailure } from "./log.ts";
import { isSecretSet } from "./secret.ts";

/** `.github/workflows/import.yml`'s file name, which the dispatch endpoint takes for its id, and the branch it runs on. */
const WORKFLOW = "import.yml";
const WORKFLOW_REF = "main";

/** What the guard reads when its var is unset. */
const FRESHNESS_DEFAULTS = {
  GITHUB_REPO: "better-giving/nonprofits",
  STALE_AFTER_DAYS: 35,
  REDISPATCH_AFTER_HOURS: 72,
};

// what GitHub accepts as owner/repo; anything else would change the path
const OWNER_REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** What the guard reads besides its vars. */
export interface FreshnessDeps {
  /** holds the `served_database` pointer */
  appDb: Client;
  /** GitHub's REST API is called through it */
  fetch: typeof fetch;
  vars: ApiVars;
}

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

function countOrDefault(value: unknown, fallback: number): number | null {
  return value === undefined ? fallback : countOf(value);
}

function configOf(vars: ApiVars): Result<FreshnessConfig, InvalidConfig> {
  const staleAfterDays = countOrDefault(
    vars.STALE_AFTER_DAYS,
    FRESHNESS_DEFAULTS.STALE_AFTER_DAYS,
  );
  if (staleAfterDays === null) {
    return invalid("STALE_AFTER_DAYS is not a positive integer");
  }
  const redispatchAfterHours = countOrDefault(
    vars.REDISPATCH_AFTER_HOURS,
    FRESHNESS_DEFAULTS.REDISPATCH_AFTER_HOURS,
  );
  if (redispatchAfterHours === null) {
    return invalid("REDISPATCH_AFTER_HOURS is not a positive integer");
  }
  const repo = vars.GITHUB_REPO ?? FRESHNESS_DEFAULTS.GITHUB_REPO;
  if (!OWNER_REPO.test(repo)) {
    return invalid("GITHUB_REPO is not owner/repo");
  }
  return { ok: true, value: { repo, staleAfterDays, redispatchAfterHours } };
}

// ?1 NEVER_BUILT, ?2 STALE_AFTER_DAYS, ?3 REDISPATCH_AFTER_HOURS; every time is
// the database's clock
const STALE =
  "(build_id = ?1 OR julianday('now') - julianday(switched_at) > ?2)";

const DISPATCHED_RECENTLY =
  "(last_dispatch_at IS NOT NULL AND (julianday('now') - julianday(last_dispatch_at)) * 24 < ?3)";

const READ_FRESHNESS_SQL = `SELECT ${STALE} AS stale, ${DISPATCHED_RECENTLY} AS dispatched_recently,
  build_id, switched_at, last_dispatch_at
FROM served_database WHERE id = 1`;

// Stamps the dispatch before the call, and only while one is still due: of two
// runs of one cron, one dispatches. A run that dies before the answer leaves
// the status null.
const RESERVE_DISPATCH_SQL = `UPDATE served_database
SET last_dispatch_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), last_dispatch_status = NULL
WHERE id = 1 AND ${STALE} AND NOT ${DISPATCHED_RECENTLY}
RETURNING last_dispatch_at`;

const RECORD_DISPATCH_SQL =
  "UPDATE served_database SET last_dispatch_status = ?1 WHERE id = 1 AND last_dispatch_at = ?2";

function log(level: "log" | "warn" | "error", entry: Record<string, unknown>) {
  console[level](JSON.stringify(entry));
}

/** GitHub's answer to one call: its HTTP status and, when not 2xx, the start of its body; a null status when no answer came. */
type GitHubAnswer =
  | { status: number; ok: boolean; body?: string }
  | { status: null; ok: false; cause: unknown };

async function callWorkflow(
  fetch: typeof globalThis.fetch,
  repo: string,
  token: string,
  action: "enable" | "dispatches",
): Promise<GitHubAnswer> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "nonprofits-api",
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
 * Starts the monthly import when the served data was never built or was
 * switched to more than `STALE_AFTER_DAYS` ago, and the last dispatch is older
 * than `REDISPATCH_AFTER_HOURS`: enables the workflow, which also brings back
 * its schedule, then dispatches it. A run already going queues the new one in
 * the workflow's `concurrency` group. Never throws: a failure is logged, and
 * the next day's run decides again.
 */
export async function guardFreshness({
  appDb,
  fetch,
  vars,
}: FreshnessDeps): Promise<void> {
  try {
    const config = configOf(vars);
    if (!config.ok) {
      log("error", {
        event: "import_dispatch_skipped",
        reason: config.error.code,
        detail: config.error.message,
      });
      return;
    }
    const { repo, staleAfterDays, redispatchAfterHours } = config.value;
    const args = [NEVER_BUILT, staleAfterDays, redispatchAfterHours];
    const { rows } = await appDb.execute({ sql: READ_FRESHNESS_SQL, args });
    const freshness = rows[0];
    if (freshness === undefined) {
      throw new Error("served_database has no row: migrate the app database");
    }
    if (!freshness.stale) {
      log("log", {
        event: "data_fresh",
        buildId: freshness.build_id,
        switchedAt: freshness.switched_at,
      });
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
    const token = vars.GITHUB_DISPATCH_TOKEN;
    if (!isSecretSet(token)) {
      log("warn", { event: "import_dispatch_skipped", reason: "token_unset" });
      return;
    }
    const reserved = await appDb.execute({ sql: RESERVE_DISPATCH_SQL, args });
    const dispatchedAt = reserved.rows[0]?.last_dispatch_at;
    if (dispatchedAt === undefined) {
      log("log", { event: "import_dispatch_skipped", reason: "no_longer_due" });
      return;
    }
    const record = async ({ status }: GitHubAnswer) => {
      if (status === null) return;
      await appDb.execute({
        sql: RECORD_DISPATCH_SQL,
        args: [status, dispatchedAt],
      });
    };
    // GitHub disables the workflow after 60 days without repository activity, and
    // a disabled workflow isn't triggered; enabling an enabled one answers 204
    const enabled = await callWorkflow(fetch, repo, token, "enable");
    if (!enabled.ok) {
      log("error", { event: "import_enable_failed", ...enabled });
      await record(enabled);
      return;
    }
    const dispatched = await callWorkflow(fetch, repo, token, "dispatches");
    log(dispatched.ok ? "log" : "error", {
      event: "import_dispatched",
      ...dispatched,
    });
    await record(dispatched);
  } catch (error) {
    logFailure("freshness_check_failed", error);
  }
}
