import { NEVER_BUILT } from "@nonprofits/db";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { createWorkerHarness, TEST_SECRETS, testEnv } from "./harness.ts";
import { virtualAt, virtualDay } from "./virtual-clock.ts";

const TOKEN = "github_pat_test-only-0123456789abcdefghijklmnopqrstuvwxyz";
const WORKFLOW_URL =
  "https://api.github.com/repos/better-giving/nonprofits/actions/workflows/import.yml";
const ENABLE_URL = `${WORKFLOW_URL}/enable`;
const DISPATCH_URL = `${WORKFLOW_URL}/dispatches`;
const GITHUB_HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "nonprofits-worker",
};

const server = createWorkerHarness({
  ...TEST_SECRETS,
  GITHUB_DISPATCH_TOKEN: TOKEN,
});

beforeAll(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("APP_DB");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await server.close();
});

interface SentRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Answers the Worker's GitHub requests by URL with `respond` (204 by default)
 * and records them. The harness sends every outbound Worker fetch through
 * this process's `globalThis.fetch`; anything not for GitHub goes to the real
 * one.
 */
function stubGitHub(
  respond: (url: string) => Response = () =>
    new Response(null, { status: 204 }),
): SentRequest[] {
  const sent: SentRequest[] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://api.github.com/")) {
        return realFetch(input, init);
      }
      sent.push({
        url,
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers)),
        body: await new Response(init?.body).text(),
      });
      return respond(url);
    },
  );
  return sent;
}

/** The served build, then the pointer's age, the claim's expiry and the last dispatch as SQLite `now` modifiers (`'-36 days'`); null for none. */
interface Generation {
  buildId?: string;
  flipped: string;
  claimExpires?: string | null;
  lastDispatch?: string | null;
}

async function setGeneration({
  buildId = "build-1",
  flipped,
  claimExpires = null,
  lastDispatch = null,
}: Generation): Promise<void> {
  const { APP_DB } = await testEnv(server);
  await APP_DB.prepare(
    `UPDATE data_generation SET active = 'a', build_id = ?1, flipped_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?2),
      claim_slot = iif(?3 IS NULL, NULL, 'b'), claim_build_id = iif(?3 IS NULL, NULL, 'refresh'),
      claimed_at = iif(?3 IS NULL, NULL, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hours')),
      claim_expires_at = iif(?3 IS NULL, NULL, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?3)),
      last_dispatch_at = iif(?4 IS NULL, NULL, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?4)),
      last_dispatch_status = iif(?4 IS NULL, NULL, 204)
    WHERE id = 1`,
  )
    .bind(buildId, flipped, claimExpires, lastDispatch)
    .all();
}

/** The structured lines the Worker logged for `event`; the harness has no flush barrier, so callers `vi.waitFor` them. */
function logged(event: string): Record<string, unknown>[] {
  return server
    .getLogs()
    .flatMap((log) =>
      log.message.startsWith("{") ? [JSON.parse(log.message)] : [],
    )
    .filter((entry) => entry.event === event);
}

function runCron(scheduledTime = new Date()) {
  server.clearLogs();
  return server.getWorker().scheduled({ cron: "17 3 * * *", scheduledTime });
}

async function lastDispatch() {
  const { APP_DB } = await testEnv(server);
  const { results } = await APP_DB.prepare(
    `SELECT last_dispatch_status AS status,
      (julianday('now') - julianday(last_dispatch_at)) * 86400 < 60 AS justNow
    FROM data_generation WHERE id = 1`,
  ).all<{ status: number | null; justNow: number | null }>();
  return results[0];
}

test("stale data: the import workflow enabled, then dispatched on main, with the token and GitHub's API headers", async () => {
  await setGeneration({ flipped: "-36 days" });
  const sent = stubGitHub();

  const run = await runCron();

  expect(run.outcome).toBe("ok");
  expect(sent).toMatchObject([
    { url: ENABLE_URL, method: "PUT", headers: GITHUB_HEADERS },
    { url: DISPATCH_URL, method: "POST", headers: GITHUB_HEADERS },
  ]);
  expect(JSON.parse(sent[1]?.body ?? "")).toStrictEqual({ ref: "main" });
});

test("data flipped within STALE_AFTER_DAYS: no call, and a data_fresh line", async () => {
  await setGeneration({ flipped: "-34 days" });
  const sent = stubGitHub();

  const run = await runCron();

  expect(run.outcome).toBe("ok");
  await vi.waitFor(() =>
    expect(logged("data_fresh")).toMatchObject([{ buildId: "build-1" }]),
  );
  expect(sent).toHaveLength(0);
});

test("a pointer still on the never-built build: a dispatch, however recent its flip", async () => {
  await setGeneration({ buildId: NEVER_BUILT, flipped: "-1 hours" });
  const sent = stubGitHub();

  await runCron();

  expect(sent.map((request) => request.url)).toStrictEqual([
    ENABLE_URL,
    DISPATCH_URL,
  ]);
});

test("stale data while a refresh holds an unexpired claim: no call, skipped as claim_held", async () => {
  await setGeneration({ flipped: "-40 days", claimExpires: "+5 hours" });
  const sent = stubGitHub();

  await runCron();

  await vi.waitFor(() =>
    expect(logged("import_dispatch_skipped")).toMatchObject([
      { reason: "claim_held" },
    ]),
  );
  expect(sent).toHaveLength(0);
});

test("stale data under a claim whose lease ran out: a dispatch", async () => {
  await setGeneration({ flipped: "-40 days", claimExpires: "-1 minutes" });
  const sent = stubGitHub();

  await runCron();

  expect(sent.map((request) => request.url)).toStrictEqual([
    ENABLE_URL,
    DISPATCH_URL,
  ]);
});

test("stale data last dispatched 50 hours ago: no call, skipped as dispatched_recently", async () => {
  await setGeneration({ flipped: "-40 days", lastDispatch: "-50 hours" });
  const sent = stubGitHub();

  await runCron();

  await vi.waitFor(() =>
    expect(logged("import_dispatch_skipped")).toMatchObject([
      { reason: "dispatched_recently" },
    ]),
  );
  expect(sent).toHaveLength(0);
});

test("stale data last dispatched 80 hours ago: dispatched again", async () => {
  await setGeneration({ flipped: "-40 days", lastDispatch: "-80 hours" });
  const sent = stubGitHub();

  await runCron();

  expect(sent.map((request) => request.url)).toStrictEqual([
    ENABLE_URL,
    DISPATCH_URL,
  ]);
});

test("a dispatch GitHub accepts is stamped, so a second run of the cron makes no call", async () => {
  await setGeneration({ flipped: "-36 days" });
  const sent = stubGitHub();

  await runCron();
  await runCron();

  expect(sent).toHaveLength(2);
  expect(await lastDispatch()).toStrictEqual({ status: 204, justNow: 1 });
});

test("GitHub refusing the dispatch (401): recorded with its status and body, the run still ok and the prune still done", async () => {
  const { APP_DB } = await testEnv(server);
  await APP_DB.prepare(
    "INSERT INTO key_usage (subject, day, requests, minute, minute_requests) VALUES ('freshness-test', ?1, 1, 0, 1)",
  )
    .bind(virtualDay(1))
    .all();
  await setGeneration({ flipped: "-36 days" });
  stubGitHub((url) =>
    url === DISPATCH_URL
      ? Response.json({ message: "Bad credentials" }, { status: 401 })
      : new Response(null, { status: 204 }),
  );

  const run = await runCron(new Date(virtualAt(20, "03:17:00")));

  expect(run.outcome).toBe("ok");
  expect(await lastDispatch()).toStrictEqual({ status: 401, justNow: 1 });
  await vi.waitFor(() =>
    expect(logged("import_dispatched")).toMatchObject([
      { status: 401, body: '{"message":"Bad credentials"}' },
    ]),
  );
  expect(JSON.stringify(server.getLogs())).not.toContain(TOKEN);
  const { results } = await APP_DB.prepare(
    "SELECT day FROM key_usage WHERE subject = 'freshness-test'",
  ).all();
  expect(results).toStrictEqual([]);
});

test("GitHub refusing to enable the workflow (403): no dispatch, the status recorded, the prune still done", async () => {
  const { APP_DB } = await testEnv(server);
  await APP_DB.prepare(
    "INSERT INTO key_usage (subject, day, requests, minute, minute_requests) VALUES ('freshness-test', ?1, 1, 0, 1)",
  )
    .bind(virtualDay(1))
    .all();
  await setGeneration({ flipped: "-36 days" });
  const sent = stubGitHub((url) =>
    url === ENABLE_URL
      ? Response.json(
          { message: "Resource not accessible by personal access token" },
          { status: 403 },
        )
      : new Response(null, { status: 204 }),
  );

  const run = await runCron(new Date(virtualAt(20, "03:17:00")));

  expect(run.outcome).toBe("ok");
  expect(sent.map((request) => request.url)).toStrictEqual([ENABLE_URL]);
  expect(await lastDispatch()).toStrictEqual({ status: 403, justNow: 1 });
  await vi.waitFor(() =>
    expect(logged("import_enable_failed")).toMatchObject([
      {
        status: 403,
        body: '{"message":"Resource not accessible by personal access token"}',
      },
    ]),
  );
  const { results } = await APP_DB.prepare(
    "SELECT day FROM key_usage WHERE subject = 'freshness-test'",
  ).all();
  expect(results).toStrictEqual([]);
});

test("a prune that fails still leaves the freshness check to run, and the run reports the prune's failure", async () => {
  const { APP_DB } = await testEnv(server);
  await setGeneration({ flipped: "-36 days" });
  const sent = stubGitHub();
  await APP_DB.prepare("ALTER TABLE key_usage RENAME TO key_usage_aside").all();
  try {
    const run = await runCron();

    expect(run.outcome).toBe("exception");
    expect(sent.map((request) => request.url)).toStrictEqual([
      ENABLE_URL,
      DISPATCH_URL,
    ]);
  } finally {
    await APP_DB.prepare(
      "ALTER TABLE key_usage_aside RENAME TO key_usage",
    ).all();
  }
});
