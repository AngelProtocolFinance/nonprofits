import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { type CliDeps, run } from "./cli.ts";
import { irsSources } from "./sources.ts";
import { remoteD1 } from "./wrangler.ts";

// wrangler's own bin is swapped for fixtures/fake-wrangler.mjs, which prints what $FAKE_WRANGLER says;
// the wrangler module's failure text, `run` and the summary around it are the shipped ones
vi.mock(import("node:child_process"), async (importOriginal) => {
  const actual = await importOriginal();
  const fake = fileURLToPath(
    new URL("../fixtures/fake-wrangler.mjs", import.meta.url),
  );
  return {
    ...actual,
    execFile: ((file: string, args: string[], ...rest: unknown[]) =>
      (actual.execFile as (...all: unknown[]) => ChildProcess)(
        file,
        [fake, ...args.slice(1)],
        ...rest,
      )) as typeof actual.execFile,
  };
});

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const API_TOKEN = "Zk3pQ9xLr7TuV2yWm5NaB8cDe1FgH4jKs6Ot0Iq_";
const DATABASE = "5f2c9a1e-7b3d-4c68-9e0a-1d4b8f6a2c37";
const API_PATH = `/accounts/${ACCOUNT_ID}/d1/database/${DATABASE}/query`;

/**
 * What `wrangler d1 execute --json` prints for a rejected request: the JSON
 * error on stdout, its notes quoting the API path, and the same cause in
 * colour on stderr under the proxy warning.
 */
const WRANGLER_OUTPUT = {
  stdout: JSON.stringify({
    error: {
      text: `Authentication error: token ${API_TOKEN} was rejected [code: 10000]`,
      notes: [
        { text: `A request to the Cloudflare API (${API_PATH}) failed.` },
      ],
    },
  }),
  stderr: [
    "▲ [WARNING] Proxy environment variables detected. We'll use your proxy for fetch requests.",
    "",
    `\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mA request to the Cloudflare API (${API_PATH}) failed.\u001b[0m`,
    "",
  ].join("\n"),
  exit: 1,
};

let work: string;
let n = 0;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "cli-redaction-"));
});

afterAll(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** `run` on a remote refresh whose every wrangler command fails as `WRANGLER_OUTPUT`, with `env` as the process env; resolves with its exit code and summary. */
async function failingRefresh(env: Record<string, string | undefined>) {
  vi.stubEnv("FAKE_WRANGLER", JSON.stringify(WRANGLER_OUTPUT));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const summary = join(work, `summary-${++n}.md`);
  const deps: CliDeps = {
    d1: () => remoteD1(),
    // built, never downloaded from: the pointer read that starts a refresh fails first
    sources: () => irsSources({ workDir: join(work, "efile") }),
    loadDir: join(work, "load"),
    onSignal: () => {},
    stopWrangler: (then) => then([]),
    runningWrangler: () => [],
    exit: () => {},
  };
  const code = await run(
    ["refresh", "--remote", "--summary", summary],
    env,
    deps,
  );
  return { code, md: await readFile(summary, "utf8") };
}

describe("run's summary redaction", () => {
  test("replaces the Cloudflare secrets in a real wrangler failure: its first line, the lines in its fence, and the unread pointer row", async () => {
    const { code, md } = await failingRefresh({
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: API_TOKEN,
    });

    expect(code).toBe(1);
    const failed = md.split("\n").filter((l) => l.startsWith("**Failed:**"));
    expect(failed).toStrictEqual([
      "**Failed:** wrangler d1 execute failed: Authentication error: token [redacted] was rejected [code: 10000]",
    ]);
    // the id sits on the later lines, under the failure's first
    expect(md).toContain(
      `\n\`\`\`\n▲ [WARNING] Proxy environment variables detected. We'll use your proxy for fetch requests.\n\n✘ [ERROR] A request to the Cloudflare API (/accounts/[redacted]/d1/database/${DATABASE}/query) failed.\n`,
    );
    expect(md).toContain(
      `"text":"A request to the Cloudflare API (/accounts/[redacted]/d1/database/${DATABASE}/query) failed."`,
    );
    expect(md).toMatch(
      /^\| served after \| unknown \| pointer unread: wrangler d1 execute failed: Authentication error: token \[redacted\] was rejected/m,
    );
    expect(md).not.toContain(ACCOUNT_ID);
    expect(md).not.toContain(API_TOKEN);
    expect(md).not.toContain("\u001b");
  });

  // the same output with no secrets in the env, so the test above reads redaction and not a fixture that never carried them
  test("leaves them as printed when the env doesn't hold them", async () => {
    const { md } = await failingRefresh({});

    expect(md).toContain(`/accounts/${ACCOUNT_ID}/d1/`);
    expect(md).toContain(`token ${API_TOKEN} was rejected`);
    expect(md).not.toContain("[redacted]");
  });

  test("redacts each secret from its own env variable", async () => {
    const accountOnly = await failingRefresh({
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    });
    const tokenOnly = await failingRefresh({ CLOUDFLARE_API_TOKEN: API_TOKEN });

    expect(accountOnly.md).not.toContain(ACCOUNT_ID);
    expect(accountOnly.md).toContain(API_TOKEN);
    expect(tokenOnly.md).not.toContain(API_TOKEN);
    expect(tokenOnly.md).toContain(ACCOUNT_ID);
  });
});
