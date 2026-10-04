import { readFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { createWorkerHarness, TEST_SECRETS, testEnv } from "./harness.ts";

const devVarsExample = await readFile(
  new URL("../.dev.vars.example", import.meta.url),
  "utf8",
);
const placeholder =
  /^GITHUB_DISPATCH_TOKEN=(.+)$/m.exec(devVarsExample)?.[1] ?? "";
const TOKEN = "github_pat_test-only-0123456789abcdefghijklmnopqrstuvwxyz";

/** Starts a harness on stale data, runs the cron once with GitHub stubbed, and returns the GitHub calls and the structured log lines. */
async function cronOnStaleData(
  secrets: Record<string, string>,
  vars: Record<string, number | string> = {},
) {
  const server = createWorkerHarness(secrets, vars);
  try {
    await server.listen();
    await server.getWorker().applyD1Migrations("APP_DB");
    const { APP_DB } = await testEnv(server);
    await APP_DB.prepare(
      "UPDATE data_generation SET build_id = 'build-1', flipped_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-40 days')",
    ).all();
    const githubCalls: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.startsWith("https://api.github.com/")) {
          return realFetch(input, init);
        }
        githubCalls.push(url);
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    );
    const run = await server.getWorker().scheduled({
      cron: "17 3 * * *",
      scheduledTime: new Date(),
    });
    const skipped = () =>
      server
        .getLogs()
        .flatMap((log) =>
          log.message.startsWith("{")
            ? [{ level: log.level, ...JSON.parse(log.message) }]
            : [],
        )
        .filter((entry) => entry.event === "import_dispatch_skipped");
    await vi.waitFor(() => expect(skipped()).toHaveLength(1));
    return { run, githubCalls, skipped: skipped()[0] };
  } finally {
    vi.unstubAllGlobals();
    await server.close();
  }
}

describe.each([
  ["unset", TEST_SECRETS],
  [
    "still the .dev.vars.example placeholder",
    { ...TEST_SECRETS, GITHUB_DISPATCH_TOKEN: placeholder },
  ],
])("stale data with GITHUB_DISPATCH_TOKEN %s", (_, secrets) => {
  test("no call, and one token_unset warning", async () => {
    const { run, githubCalls, skipped } = await cronOnStaleData(secrets);

    expect(run.outcome).toBe("ok");
    expect(githubCalls).toStrictEqual([]);
    expect(skipped).toMatchObject({ level: "warn", reason: "token_unset" });
  });
});

describe.each([
  ["STALE_AFTER_DAYS", "soon"],
  ["REDISPATCH_AFTER_HOURS", 0],
  ["GITHUB_REPO", "better-giving/nonprofits/../other"],
])("stale data with %s set to %j", (name, value) => {
  test("no call, skipped as invalid_config naming the var, the run still ok", async () => {
    const { run, githubCalls, skipped } = await cronOnStaleData(
      { ...TEST_SECRETS, GITHUB_DISPATCH_TOKEN: TOKEN },
      { [name]: value },
    );

    expect(run.outcome).toBe("ok");
    expect(githubCalls).toStrictEqual([]);
    expect(skipped).toMatchObject({ reason: "invalid_config" });
    expect(skipped.detail).toMatch(new RegExp(`^${name} `));
  });
});
