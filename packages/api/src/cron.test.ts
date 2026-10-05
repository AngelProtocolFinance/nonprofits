import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CRON_AUTHORIZATION,
  failingDb,
  seedUsage,
  type TestApi,
  type TestApiOptions,
  testApi,
} from "./test-support.ts";

const TOKEN = "github_pat_test-only-0123456789abcdefghijklmnopqrstuvwxyz";
const WORKFLOW_URL =
  "https://api.github.com/repos/better-giving/nonprofits/actions/workflows/import.yml";
const ENABLE_URL = `${WORKFLOW_URL}/enable`;
const DISPATCH_URL = `${WORKFLOW_URL}/dispatches`;
const GITHUB_HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "nonprofits-api",
};

let api: TestApi;

afterEach(async () => {
  vi.restoreAllMocks();
  await api.dispose();
});

interface SentRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** A fetch that answers GitHub by URL with `respond` (204 by default) and records each call. */
function gitHub(
  respond: (url: string) => Response = () =>
    new Response(null, { status: 204 }),
) {
  const sent: SentRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    sent.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: await new Response(init?.body).text(),
    });
    return respond(url);
  };
  return { sent, fetch };
}

async function start(options: TestApiOptions = {}) {
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
  api = await testApi({
    ...options,
    vars: { GITHUB_DISPATCH_TOKEN: TOKEN, ...options.vars },
  });
  return api;
}

/** Moves the served pointer's switch, and its last dispatch, by SQLite `now` modifiers (`'-36 days'`); null for no dispatch. */
async function servedSince(
  switched: string,
  lastDispatch: string | null = null,
) {
  await api.appDb.client.execute({
    sql: `UPDATE served_database SET switched_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?1),
      last_dispatch_at = iif(?2 IS NULL, NULL, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?2)),
      last_dispatch_status = iif(?2 IS NULL, NULL, 204)
    WHERE id = 1`,
    args: [switched, lastDispatch],
  });
}

/** The structured lines logged for `event`, each with the console method that wrote it. */
function logged(event: string): Record<string, unknown>[] {
  return (["log", "warn", "error"] as const)
    .flatMap((level) =>
      vi
        .mocked(console[level])
        .mock.calls.flatMap(([line]) =>
          typeof line === "string" && line.startsWith("{")
            ? [{ level, ...JSON.parse(line) }]
            : [],
        ),
    )
    .filter((entry) => entry.event === event);
}

async function lastDispatch() {
  const { rows } = await api.appDb.client.execute(
    `SELECT last_dispatch_status AS status,
      (julianday('now') - julianday(last_dispatch_at)) * 86400 < 60 AS justNow
    FROM served_database WHERE id = 1`,
  );
  return { status: rows[0]?.status, justNow: rows[0]?.justNow };
}

/** Usage days left in `key_usage`, oldest first. */
async function usageDays(): Promise<string[]> {
  const { rows } = await api.appDb.client.execute(
    "SELECT day FROM key_usage ORDER BY day",
  );
  return rows.map((row) => String(row.day));
}

function runCron(authorization: string | null = CRON_AUTHORIZATION) {
  return api.app.request("/cron/daily", {
    headers: authorization === null ? {} : { authorization },
  });
}

test("stale data: the import workflow enabled, then dispatched on main, with the token and GitHub's API headers", async () => {
  const github = gitHub();
  await start({ fetch: github.fetch });
  await servedSince("-36 days");

  const res = await runCron();

  expect(res.status).toBe(204);
  expect(github.sent).toMatchObject([
    { url: ENABLE_URL, method: "PUT", headers: GITHUB_HEADERS },
    { url: DISPATCH_URL, method: "POST", headers: GITHUB_HEADERS },
  ]);
  expect(JSON.parse(github.sent[1]?.body ?? "")).toStrictEqual({
    ref: "main",
  });
});

describe.each([
  ["no Authorization header", null],
  ["another secret", "Bearer test-only-not-the-cron-secret-0123456789"],
  ["the secret without its scheme", CRON_AUTHORIZATION.slice("Bearer ".length)],
])("a cron call with %s", (_, authorization) => {
  test("401, and neither prune nor dispatch runs", async () => {
    const github = gitHub();
    await start({ fetch: github.fetch });
    await servedSince("-36 days");
    await seedUsage(api, "cron-test", "2026-09-01", 1);

    const res = await runCron(authorization);

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "cron_unauthorized" });
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /);
    expect(github.sent).toStrictEqual([]);
    expect(await usageDays()).toStrictEqual(["2026-09-01"]);
  });
});

describe.each([
  ["unset", undefined],
  ["the example placeholder", "replace-with-32-plus-random-characters"],
  ["shorter than 32 characters", "short-cron-secret"],
])("CRON_SECRET %s", (_, secret) => {
  test("503 even to a caller sending that value, and nothing runs", async () => {
    const github = gitHub();
    await start({ fetch: github.fetch, vars: { CRON_SECRET: secret } });
    await servedSince("-36 days");
    await seedUsage(api, "cron-test", "2026-09-01", 1);

    const res = await runCron(`Bearer ${secret}`);

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "cron_disabled" });
    expect(github.sent).toStrictEqual([]);
    expect(await usageDays()).toStrictEqual(["2026-09-01"]);
  });
});

test("data switched to within STALE_AFTER_DAYS: no call, and a data_fresh line", async () => {
  const github = gitHub();
  await start({ fetch: github.fetch });
  await servedSince("-34 days");

  const res = await runCron();

  expect(res.status).toBe(204);
  expect(logged("data_fresh")).toMatchObject([{ buildId: "20260910T030000Z" }]);
  expect(github.sent).toStrictEqual([]);
});

test("a pointer never switched to a build: a dispatch, however recent its switch", async () => {
  const github = gitHub();
  await start({ fetch: github.fetch, serve: false });
  await servedSince("-1 hours");

  await runCron();

  expect(github.sent.map((request) => request.url)).toStrictEqual([
    ENABLE_URL,
    DISPATCH_URL,
  ]);
});

test("STALE_AFTER_DAYS set as env text: data older than it is stale", async () => {
  const github = gitHub();
  await start({ fetch: github.fetch, vars: { STALE_AFTER_DAYS: "10" } });
  await servedSince("-12 days");

  await runCron();

  expect(github.sent.map((request) => request.url)).toStrictEqual([
    ENABLE_URL,
    DISPATCH_URL,
  ]);
});

test("stale data last dispatched 50 hours ago: no call, skipped as dispatched_recently", async () => {
  const github = gitHub();
  await start({ fetch: github.fetch });
  await servedSince("-40 days", "-50 hours");

  await runCron();

  expect(logged("import_dispatch_skipped")).toMatchObject([
    { reason: "dispatched_recently" },
  ]);
  expect(github.sent).toStrictEqual([]);
});

test("stale data last dispatched 80 hours ago: dispatched again", async () => {
  const github = gitHub();
  await start({ fetch: github.fetch });
  await servedSince("-40 days", "-80 hours");

  await runCron();

  expect(github.sent.map((request) => request.url)).toStrictEqual([
    ENABLE_URL,
    DISPATCH_URL,
  ]);
});

test("a dispatch GitHub accepts is stamped, so a second run of the cron makes no call", async () => {
  const github = gitHub();
  await start({ fetch: github.fetch });
  await servedSince("-36 days");

  await runCron();
  await runCron();

  expect(github.sent).toHaveLength(2);
  expect(await lastDispatch()).toStrictEqual({ status: 204, justNow: 1 });
});

test("two runs of the cron at once dispatch once", async () => {
  const github = gitHub();
  await start({ fetch: github.fetch });
  await servedSince("-36 days");

  const runs = await Promise.all([runCron(), runCron()]);

  expect(runs.map((res) => res.status)).toStrictEqual([204, 204]);
  expect(github.sent.map((request) => request.url)).toStrictEqual([
    ENABLE_URL,
    DISPATCH_URL,
  ]);
});

test("GitHub refusing the dispatch (401): recorded with its status and body, the token never logged, the prune still done", async () => {
  const github = gitHub((url) =>
    url === DISPATCH_URL
      ? Response.json({ message: "Bad credentials" }, { status: 401 })
      : new Response(null, { status: 204 }),
  );
  await start({ fetch: github.fetch });
  await servedSince("-36 days");
  await seedUsage(api, "cron-test", "2026-09-01", 1);

  const res = await runCron();

  expect(res.status).toBe(204);
  expect(await lastDispatch()).toStrictEqual({ status: 401, justNow: 1 });
  expect(logged("import_dispatched")).toMatchObject([
    { level: "error", status: 401, body: '{"message":"Bad credentials"}' },
  ]);
  const lines = (["log", "warn", "error"] as const).flatMap((level) =>
    vi.mocked(console[level]).mock.calls.map((call) => String(call[0])),
  );
  expect(lines.join("\n")).not.toContain(TOKEN);
  expect(await usageDays()).toStrictEqual([]);
});

test("GitHub refusing to enable the workflow (403): no dispatch, the status recorded, the prune still done", async () => {
  const github = gitHub((url) =>
    url === ENABLE_URL
      ? Response.json(
          { message: "Resource not accessible by personal access token" },
          { status: 403 },
        )
      : new Response(null, { status: 204 }),
  );
  await start({ fetch: github.fetch });
  await servedSince("-36 days");
  await seedUsage(api, "cron-test", "2026-09-01", 1);

  const res = await runCron();

  expect(res.status).toBe(204);
  expect(github.sent.map((request) => request.url)).toStrictEqual([ENABLE_URL]);
  expect(await lastDispatch()).toStrictEqual({ status: 403, justNow: 1 });
  expect(logged("import_enable_failed")).toMatchObject([
    {
      status: 403,
      body: '{"message":"Resource not accessible by personal access token"}',
    },
  ]);
  expect(await usageDays()).toStrictEqual([]);
});

test("a prune that fails still leaves the freshness guard to run, and the run answers 500", async () => {
  const github = gitHub();
  await start({
    fetch: github.fetch,
    appDbAs: (db) => failingDb(db, /DELETE FROM key_usage/),
  });
  await servedSince("-36 days");

  const res = await runCron();

  expect(res.status).toBe(500);
  expect(github.sent.map((request) => request.url)).toStrictEqual([
    ENABLE_URL,
    DISPATCH_URL,
  ]);
  expect(logged("internal_error")).toMatchObject([
    { cause: "Error: app database unreachable" },
  ]);
});

test("the daily cron prunes usage rows more than 7 days older than its run, and keeps the rest", async () => {
  await start();
  api.clock.set("2026-10-20T03:17:00Z");
  for (const day of [
    "2026-10-10",
    "2026-10-12",
    "2026-10-13",
    "2026-10-19",
    "2026-10-20",
  ]) {
    await seedUsage(api, "prune-test", day, 1);
  }

  const res = await runCron();

  expect(res.status).toBe(204);
  expect(await usageDays()).toStrictEqual([
    "2026-10-13",
    "2026-10-19",
    "2026-10-20",
  ]);
});

describe.each([
  ["unset", undefined],
  ["still the example placeholder", "replace-with-a-fine-grained-github-token"],
])("stale data with GITHUB_DISPATCH_TOKEN %s", (_, token) => {
  test("no call, and one token_unset warning", async () => {
    const github = gitHub();
    await start({
      fetch: github.fetch,
      vars: { GITHUB_DISPATCH_TOKEN: token },
    });
    await servedSince("-40 days");

    const res = await runCron();

    expect(res.status).toBe(204);
    expect(github.sent).toStrictEqual([]);
    expect(logged("import_dispatch_skipped")).toStrictEqual([
      {
        level: "warn",
        event: "import_dispatch_skipped",
        reason: "token_unset",
      },
    ]);
  });
});

describe.each([
  ["STALE_AFTER_DAYS", "soon"],
  ["REDISPATCH_AFTER_HOURS", "0"],
  ["GITHUB_REPO", "better-giving/nonprofits/../other"],
])("stale data with %s set to %j", (name, value) => {
  test("no call, skipped as invalid_config naming the var, the run still 204", async () => {
    const github = gitHub();
    await start({ fetch: github.fetch, vars: { [name]: value } });
    await servedSince("-40 days");

    const res = await runCron();

    expect(res.status).toBe(204);
    expect(github.sent).toStrictEqual([]);
    const [skipped] = logged("import_dispatch_skipped");
    expect(skipped).toMatchObject({ level: "error", reason: "invalid_config" });
    expect(skipped?.detail).toMatch(new RegExp(`^${name} `));
  });
});
