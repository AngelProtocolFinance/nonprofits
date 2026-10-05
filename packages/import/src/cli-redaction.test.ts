import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { switchServedDatabase } from "@nonprofits/db";
import { appDbFixture, type LocalDb } from "@nonprofits/db/fixture";
import { appDbClient } from "@nonprofits/db/node";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type CliDeps, run } from "./cli.ts";
import type { DatabaseHost } from "./publish.ts";
import { FIXTURE_COUNTS } from "./test-support.ts";

const APP_TOKEN = "app-eyJhbGciOiJFZERTQSJ9.YXBwLXRva2Vu.Q9xLr7TuV2yWm5Na";
const PLATFORM_TOKEN = "platform-Zk3pQ9xLr7TuV2yWm5NaB8cDe1FgH4jKs6Ot0Iq";
const MINTED = "minted-eyJhbGciOiJFZERTQSJ9.bWludGVk.B8cDe1FgH4jKs6Ot";

let work: string;
let app: LocalDb;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "cli-redaction-"));
  app = await appDbFixture();
  await switchServedDatabase(app.client, {
    expected: null,
    to: {
      name: "nonprofits-data-x",
      url: "libsql://nonprofits-data-x.turso.io",
    },
    buildId: "b1",
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

/**
 * A host whose read of the served database mints a token, adding it to its
 * secrets as Turso's does, then fails quoting it and every env secret, on its
 * first line and the ones after, as an HTTP client's error can.
 */
function quotingHost(): DatabaseHost {
  const secrets = [PLATFORM_TOKEN];
  const never = () => Promise.reject(new Error("not reached"));
  return {
    secrets,
    create: never,
    upload: never,
    async open() {
      secrets.push(MINTED);
      throw new Error(
        `POST /v2/pipeline answered 401: token ${MINTED} rejected\nAuthorization: Bearer ${APP_TOKEN}\nx-platform: ${PLATFORM_TOKEN}`,
      );
    },
    remove: never,
    removeCommand: (name) => `turso db destroy ${name} --yes`,
  };
}

/** `run` on a refresh failing as `quotingHost` does, with `env` as the process env; its exit code, summary and stderr. */
async function failingRefresh(env: Record<string, string | undefined>) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const summary = join(work, "summary.md");
  const deps: CliDeps = {
    databases: () => ({
      app: appDbClient({ TURSO_APP_DB_URL: app.url }),
      host: quotingHost(),
    }),
    // never downloaded from: reading the served counts fails first
    sources: () => {
      throw new Error("not reached");
    },
    floors: FIXTURE_COUNTS,
    loadDir: join(work, "load"),
    dataFile: join(work, "data.db"),
    onSignal: () => {},
    exit: () => {},
  };
  const code = await run(["refresh", "--summary", summary], env, deps);
  const stderr = error.mock.calls.map((args) => args.join(" ")).join("\n");
  return { code, md: await readFile(summary, "utf8"), stderr };
}

const ENV = {
  TURSO_APP_DB_TOKEN: APP_TOKEN,
  TURSO_PLATFORM_TOKEN: PLATFORM_TOKEN,
};

describe("run's redaction", () => {
  test("replaces the env's Turso tokens and one the host minted during the run in the summary: the failure's first line and the lines in its fence", async () => {
    const { code, md } = await failingRefresh(ENV);

    expect(code).toBe(1);
    expect(md).toContain(
      "**Failed:** POST /v2/pipeline answered 401: token [redacted] rejected\n",
    );
    expect(md).toContain(
      "\n```\nAuthorization: Bearer [redacted]\nx-platform: [redacted]\n```\n",
    );
    for (const secret of [APP_TOKEN, PLATFORM_TOKEN, MINTED]) {
      expect(md).not.toContain(secret);
    }
  });

  test("replaces them in the failure the run prints on stderr", async () => {
    const { stderr } = await failingRefresh(ENV);

    expect(stderr).toContain(
      "POST /v2/pipeline answered 401: token [redacted] rejected",
    );
    for (const secret of [APP_TOKEN, PLATFORM_TOKEN, MINTED]) {
      expect(stderr).not.toContain(secret);
    }
  });

  // the same failure with neither env token set, so the tests above read redaction and not a fixture that never carried them
  test("leaves the env's tokens as printed when the env doesn't hold them", async () => {
    const { md, stderr } = await failingRefresh({});

    expect(md).toContain(`Authorization: Bearer ${APP_TOKEN}`);
    expect(stderr).toContain(`Authorization: Bearer ${APP_TOKEN}`);
    // the host's own secrets still are
    expect(md).not.toContain(MINTED);
    expect(md).not.toContain(PLATFORM_TOKEN);
  });
});
