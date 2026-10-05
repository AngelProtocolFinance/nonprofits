import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { appDbFixture, type LocalDb } from "@nonprofits/db/fixture";
import { afterEach, describe, expect, test, vi } from "vitest";
import { missingEnv, PRODUCTION_ENV } from "./production.ts";

const API_ROOT = new URL("../", import.meta.url);

interface VercelConfig {
  regions?: string[];
  crons?: { path: string; schedule: string }[];
}

async function vercelConfig(): Promise<VercelConfig> {
  return JSON.parse(await readFile(new URL("vercel.json", API_ROOT), "utf8"));
}

/** `NAME=value` lines of `.env.example`. */
async function exampleEnv(): Promise<Record<string, string>> {
  const text = await readFile(new URL(".env.example", API_ROOT), "utf8");
  return Object.fromEntries(
    [...text.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map(([, name, value]) => [
      name,
      value,
    ]),
  );
}

/** Values `missingEnv` passes, none of them a real credential. */
const COMPLETE_ENV: Record<string, string> = {
  TURSO_APP_DB_URL: ":memory:",
  TURSO_APP_DB_TOKEN: "test-only-turso-app-token-0123456789abcdef",
  TURSO_DATA_DB_TOKEN: "test-only-turso-data-token-0123456789abcdef",
  IP_HASH_SECRET: "test-only-ip-hash-secret-0123456789abcdef",
  BETTER_AUTH_SECRET: "test-only-better-auth-secret-0123456789abcdef",
  ADMIN_TOKEN: "test-only-admin-token-0123456789abcdef",
  CRON_SECRET: "test-only-cron-secret-0123456789abcdef",
  GITHUB_DISPATCH_TOKEN: "github_pat_test-only-0123456789abcdefghijklmnop",
};

const NEEDED = Object.entries(PRODUCTION_ENV)
  .filter(([, need]) => need !== "optional")
  .map(([name]) => name);

const PLATFORM_GIT_VARS = [
  "VERCEL_GIT_PROVIDER",
  "VERCEL_GIT_REPO_OWNER",
  "VERCEL_GIT_REPO_SLUG",
];

/** `server.ts`'s default export, imported fresh over exactly `env`. */
async function serverOver(env: Record<string, string>) {
  for (const name of [...Object.keys(PRODUCTION_ENV), ...PLATFORM_GIT_VARS]) {
    vi.stubEnv(name, env[name]);
  }
  vi.resetModules();
  return (await import("../server.ts")).default;
}

/** A global fetch answering 204 to every call, recording each URL. */
function stubGitHub(): string[] {
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    urls.push(input instanceof Request ? input.url : String(input));
    return new Response(null, { status: 204 });
  };
  vi.stubGlobal("fetch", fetch);
  return urls;
}

let appDb: LocalDb | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await appDb?.dispose();
  appDb = undefined;
});

function quiet() {
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
}

describe("vercel.json", () => {
  test("runs functions in US East only, beside the Turso group", async () => {
    expect((await vercelConfig()).regions).toEqual(["iad1"]);
  });

  test("schedules one cron, once a UTC day", async () => {
    const crons = (await vercelConfig()).crons ?? [];
    expect(crons).toHaveLength(1);
    const [minute, hour, ...rest] = crons[0]?.schedule.split(" ") ?? [];
    expect(Number(minute)).toBeGreaterThanOrEqual(0);
    expect(Number(minute)).toBeLessThan(60);
    expect(Number(hour)).toBeGreaterThanOrEqual(0);
    expect(Number(hour)).toBeLessThan(24);
    expect(rest).toEqual(["*", "*", "*"]);
  });

  test("points the cron at a route the deployed entry serves", async () => {
    quiet();
    stubGitHub();
    appDb = await appDbFixture();
    const server = await serverOver({
      ...COMPLETE_ENV,
      TURSO_APP_DB_URL: appDb.url,
    });
    const [cron] = (await vercelConfig()).crons ?? [];
    const response = await server.request(cron?.path ?? "", {
      headers: { authorization: `Bearer ${COMPLETE_ENV.CRON_SECRET}` },
    });
    expect(response.status).toBe(204);
  });
});

describe("the bundle Vercel deploys", () => {
  test("boots in plain Node and queries the app database", {
    timeout: 30_000,
  }, async () => {
    const run = promisify(execFile);
    await run(process.execPath, ["build.ts"], { cwd: fileURLToPath(API_ROOT) });
    appDb = await appDbFixture();
    const listKeys = `
      const { default: app } = await import(process.argv[1]);
      const response = await app.fetch(new Request("https://deployment.test/admin/keys", {
        headers: { authorization: "Bearer " + process.env.ADMIN_TOKEN },
      }));
      console.log(response.status, await response.text());`;
    const { stdout } = await run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        listKeys,
        new URL("dist/server.js", API_ROOT).href,
      ],
      {
        env: {
          PATH: process.env.PATH,
          ...COMPLETE_ENV,
          TURSO_APP_DB_URL: appDb.url,
        },
      },
    );
    expect(stdout).toMatch(/^200 /);
  });
});

describe("start-up check", () => {
  test.each(NEEDED)(
    "a deployment without %s serves nothing and names it",
    async (name) => {
      quiet();
      const server = await serverOver({ ...COMPLETE_ENV, [name]: "" });
      const requests: [string, RequestInit][] = [
        ["/v1/orgs/530196605", {}],
        ["/v1/search?q=red%20cross", {}],
        ["/mcp", { method: "POST", body: "{}" }],
        [
          "/admin/keys",
          { headers: { authorization: `Bearer ${COMPLETE_ENV.ADMIN_TOKEN}` } },
        ],
        [
          "/cron/daily",
          { headers: { authorization: `Bearer ${COMPLETE_ENV.CRON_SECRET}` } },
        ],
      ];
      for (const [path, init] of requests) {
        const response = await server.request(path, init);
        expect(response.status, path).toBe(503);
        expect(await response.json(), path).toMatchObject({
          code: "server_misconfigured",
          detail: expect.stringMatching(new RegExp(`\\b${name}\\b`)),
        });
      }
    },
  );

  test("passes an env holding every needed var", () => {
    expect(missingEnv(COMPLETE_ENV)).toEqual([]);
  });

  test("counts a placeholder or a short secret as missing", () => {
    expect(
      missingEnv({
        ...COMPLETE_ENV,
        TURSO_APP_DB_URL: "replace-with-libsql-url",
        CRON_SECRET: "replace-with-a-secret-at-least-32-characters-long",
        ADMIN_TOKEN: "31-characters-xxxxxxxxxxxxxxxxx",
      }),
    ).toEqual(["ADMIN_TOKEN", "CRON_SECRET", "TURSO_APP_DB_URL"]);
  });

  test("with the example's empty optional vars, the cron dispatches the deployed repository's import", async () => {
    quiet();
    const urls = stubGitHub();
    appDb = await appDbFixture();
    const optional = Object.fromEntries(
      Object.entries(await exampleEnv()).filter(
        ([name]) => PRODUCTION_ENV[name] === "optional",
      ),
    );
    const server = await serverOver({
      ...optional,
      ...COMPLETE_ENV,
      TURSO_APP_DB_URL: appDb.url,
      VERCEL_GIT_PROVIDER: "github",
      VERCEL_GIT_REPO_OWNER: "a-fork",
      VERCEL_GIT_REPO_SLUG: "nonprofits",
    });
    const response = await server.request("/cron/daily", {
      headers: { authorization: `Bearer ${COMPLETE_ENV.CRON_SECRET}` },
    });
    expect(response.status).toBe(204);
    expect(urls).toContain(
      "https://api.github.com/repos/a-fork/nonprofits/actions/workflows/import.yml/dispatches",
    );
  });
});

describe(".env.example", () => {
  test("lists exactly the vars the deployed app reads", async () => {
    expect(Object.keys(await exampleEnv()).sort()).toEqual(
      Object.keys(PRODUCTION_ENV).sort(),
    );
  });

  test("holds placeholders only: a copy of it serves nothing", async () => {
    expect(missingEnv(await exampleEnv())).toEqual(NEEDED);
  });

  test("no module the deployment serves reads the environment past PRODUCTION_ENV", async () => {
    // NODE_ENV is the runtime's own; firewall-limiter.ts refuses requests unless it is production
    const allowed = new Set([...Object.keys(PRODUCTION_ENV), "NODE_ENV"]);
    // run locally or by the import job, never by the deployed app
    const unserved =
      /\.test\.ts$|^test-support\.ts$|^dev\.ts$|^migrate-cli\.ts$|^fixture\.ts$/;
    const dirs = ["src/", "../core/src/", "../db/src/"].map(
      (dir) => new URL(dir, API_ROOT),
    );
    const reads: string[] = [];
    for (const dir of dirs) {
      for (const file of await readdir(dir)) {
        if (!file.endsWith(".ts") || unserved.test(file)) continue;
        const source = await readFile(new URL(file, dir), "utf8");
        for (const [, name] of source.matchAll(/process\.env(?:\.(\w+)|\[)/g)) {
          reads.push(name ?? `${file}: process.env[...]`);
        }
      }
    }
    expect(reads.filter((name) => !allowed.has(name))).toEqual([]);
  });
});
