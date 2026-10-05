import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  type Mock,
  test,
  vi,
} from "vitest";
import { type CliDeps, DATA_FILE_NAME, run } from "./cli.ts";
import { type RunRecord, renderSummary, runRecord } from "./summary.ts";
import { FIXTURE_COUNTS } from "./test-support.ts";

const WORKFLOW = readFileSync(
  new URL("../../../.github/workflows/import.yml", import.meta.url),
  "utf8",
);

/** The step named `name`: from its `- name:` line to the next step's. */
function step(name: string): string {
  const lines = WORKFLOW.split("\n");
  const start = lines.indexOf(`      - name: ${name}`);
  if (start === -1) throw new Error(`import.yml has no step "${name}"`);
  const next = lines.findIndex((line, i) => i > start && /^ {6}- /.test(line));
  return lines.slice(start, next === -1 ? undefined : next).join("\n");
}

/** The block scalar under `key: |` in `text`, dedented. */
function block(text: string, key: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((line) =>
    new RegExp(`^\\s*${key}: \\|$`).test(line),
  );
  if (at === -1) throw new Error(`no "${key}: |" block`);
  const indent = (lines[at]?.match(/^\s*/)?.[0].length ?? 0) + 2;
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && !line.startsWith(" ".repeat(indent))) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

const CHECK = step("Check the Turso secrets are set");
const IMPORT = step("Import");
const RUN_SUMMARY = step("Run summary");
const ISSUE = step("Open or comment on the failure issue");
const CLEANUP = step("Clean up downloads, load files and the built file");

/** The path the import step has the CLI write its summary to, as the shell spells it. */
const SUMMARY_PATH = /--summary "([^"]+)"/.exec(IMPORT)?.[1] ?? "";

/** The repository secrets `text` reads, by name. */
const secretsIn = (text: string) =>
  [...text.matchAll(/\$\{\{ secrets\.(\w+) \}\}/g)].map((m) => m[1]).sort();

/** A refresh's record with `fields` set. */
const record = (fields: Partial<RunRecord> = {}): RunRecord => ({
  ...runRecord(),
  ...fields,
});

let work: string;
let n = 0;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "workflow-"));
});

afterAll(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

/**
 * `script` run as GitHub runs a step (`bash -eo pipefail`) in a directory of
 * its own, which is also `RUNNER_TEMP`, with `env`, and `node` a stub that
 * records its args; resolves with its exit code, its stdout and node's calls.
 */
async function bashStep(
  script: string,
  env: Record<string, string> = {},
  setUp: (dir: string) => Promise<void> = async () => {},
) {
  const dir = join(work, `step-${++n}`);
  const bin = join(dir, "bin");
  const calls = join(dir, "calls");
  await mkdir(bin, { recursive: true });
  await writeFile(calls, "");
  await writeFile(join(bin, "node"), `#!/bin/sh\necho "$@" >> "$CALLS"\n`);
  await chmod(join(bin, "node"), 0o755);
  await setUp(dir);
  const { code, stdout } = await new Promise<{ code: number; stdout: string }>(
    (resolve) => {
      execFile(
        "bash",
        ["-eo", "pipefail", "-c", script],
        {
          cwd: dir,
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            RUNNER_TEMP: dir,
            CALLS: calls,
            ...env,
          },
        },
        (error, out) =>
          resolve({
            code: error === null ? 0 : ((error.code as number) ?? 1),
            stdout: out,
          }),
      );
    },
  );
  return {
    dir,
    code,
    stdout,
    calls: (await readFile(calls, "utf8")).split("\n").filter(Boolean),
  };
}

/** Every secret the check step requires, set as a Turso Cloud deploy sets them. */
const TURSO_SECRETS = {
  TURSO_APP_DB_URL: "libsql://nonprofits-app-acme.aws-us-east-1.turso.io",
  TURSO_APP_DB_TOKEN: "app-token",
  TURSO_PLATFORM_TOKEN: "platform-token",
  TURSO_ORG: "acme",
  TURSO_GROUP: "us-east",
};

describe("import.yml", () => {
  test("names no Cloudflare secret, no wrangler or D1, and no release or rollback input or command", () => {
    expect(WORKFLOW).not.toMatch(/cloudflare|wrangler|\bd1\b/i);
    expect(WORKFLOW).not.toMatch(
      /inputs\.rollback|^ {6}rollback:|(cli\.ts|irs) (release|rollback)/m,
    );
  });

  test("the steps that read the run summary read the path the import step writes it to", () => {
    expect(SUMMARY_PATH).toBe("$RUNNER_TEMP/import-summary.md");
    expect(block(RUN_SUMMARY, "run")).toContain(`summary="${SUMMARY_PATH}"`);
    expect(block(ISSUE, "script")).toContain(
      SUMMARY_PATH.replace("$RUNNER_TEMP", "${process.env.RUNNER_TEMP}"),
    );
  });

  test("the import step hands the CLI each secret the check step requires, and no other", () => {
    expect(secretsIn(IMPORT)).toStrictEqual(Object.keys(TURSO_SECRETS).sort());
    expect(secretsIn(CHECK)).toStrictEqual(Object.keys(TURSO_SECRETS).sort());
  });
});

describe("import.yml's secrets check", () => {
  test("passes with every Turso secret set and a Turso Cloud app database", async () => {
    expect((await bashStep(block(CHECK, "run"), TURSO_SECRETS)).code).toBe(0);
  });

  test("fails naming each secret missing", async () => {
    const { TURSO_PLATFORM_TOKEN, TURSO_GROUP, ...some } = TURSO_SECRETS;
    const step = await bashStep(block(CHECK, "run"), some);

    expect(step.code).toBe(1);
    expect(step.stdout).toContain(
      "::error title=Missing repository secret::TURSO_PLATFORM_TOKEN TURSO_GROUP not set",
    );
  });

  // any other app database publishes to files on the runner, which nothing serves
  test("fails an app database that isn't a Turso Cloud one, never printing its url", async () => {
    const step = await bashStep(block(CHECK, "run"), {
      ...TURSO_SECRETS,
      TURSO_APP_DB_URL: "file:/tmp/app.db",
    });

    expect(step.code).toBe(1);
    expect(step.stdout).toContain("::error title=Not a Turso Cloud database::");
    expect(step.stdout).not.toContain("/tmp/app.db");
  });
});

describe("import.yml's import step", () => {
  test.each([
    ["a scheduled run", "", []],
    [
      "a dispatch with force_verify_failure",
      "true",
      ["--force-verify-failure"],
    ],
  ])(
    "%s runs refresh with the flags the CLI takes",
    async (_, force, flags) => {
      const step = await bashStep(block(IMPORT, "run"), {
        FORCE_VERIFY_FAILURE: force,
      });
      const summary = join(step.dir, "import-summary.md");

      expect(step.calls).toStrictEqual([
        [
          "packages/import/src/cli.ts",
          "refresh",
          ...flags,
          "--summary",
          summary,
        ].join(" "),
      ]);
      // the CLI parses them and goes on to open its databases: a usage error would exit 2 first
      const argv = step.calls[0]?.split(" ").slice(1) ?? [];
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      const code = await run(argv, {}, {
        databases: () => {
          throw new Error("reached the databases");
        },
        sources: () => {
          throw new Error("not reached");
        },
        floors: FIXTURE_COUNTS,
        loadDir: join(step.dir, "load"),
        dataFile: join(step.dir, DATA_FILE_NAME),
        onSignal: () => {},
        exit: () => {},
      } satisfies CliDeps);
      const printed = stderr.mock.calls.map((args) => args.join(" "));
      stderr.mockRestore();
      expect(code).toBe(1);
      expect(printed).toStrictEqual(["reached the databases"]);
    },
  );
});

describe("import.yml's run summary step", () => {
  test("adds the CLI's summary to the job's, and warns of a database a run left behind", async () => {
    const md = renderSummary(
      record({ cleanup: "turso db destroy nonprofits-data-b1 --yes" }),
    );

    const jobSummary = join(work, "job-summary-cleanup.md");

    const step = await bashStep(
      block(RUN_SUMMARY, "run"),
      { GITHUB_STEP_SUMMARY: jobSummary },
      (dir) => writeFile(join(dir, "import-summary.md"), md),
    );

    expect(step.code).toBe(0);
    expect(await readFile(jobSummary, "utf8")).toBe(md);
    expect(step.stdout).toContain("::warning title=Database left behind::");
  });

  test("warns of nothing when the run left no database behind", async () => {
    const step = await bashStep(
      block(RUN_SUMMARY, "run"),
      { GITHUB_STEP_SUMMARY: join(work, "job-summary-none.md") },
      (dir) =>
        writeFile(join(dir, "import-summary.md"), renderSummary(record())),
    );

    expect(step.code).toBe(0);
    expect(step.stdout).not.toContain("::warning");
  });
});

describe("import.yml's cleanup step", () => {
  test("deletes the downloads, the load files and the file the CLI built", async () => {
    const step = await bashStep(block(CLEANUP, "run"), {}, async (dir) => {
      await mkdir(join(dir, dirname(DATA_FILE_NAME), "efile"), {
        recursive: true,
      });
      await writeFile(join(dir, DATA_FILE_NAME), "the built file");
      await writeFile(
        join(dir, `${DATA_FILE_NAME}.building`),
        "a stopped build",
      );
      await mkdir(join(dir, "load"));
      await writeFile(join(dir, "load", "bmf.load.sql"), "a load file");
    });

    expect(step.code).toBe(0);
    expect(
      [
        DATA_FILE_NAME,
        `${DATA_FILE_NAME}.building`,
        "load",
        "data/efile",
      ].filter((path) => existsSync(join(step.dir, path))),
    ).toStrictEqual([]);
  });
});

/** What the script sends GitHub to open an issue or add a comment. */
interface IssueCall {
  body: string;
  issue_number?: number;
}

/** The failure issue step's script run over `summary` (none when null), the issues listed open being `open`; resolves with what it created or commented. */
async function issueStep(summary: string | null, open: unknown[] = []) {
  const dir = join(work, `issue-${++n}`);
  await mkdir(dir, { recursive: true });
  if (summary !== null) {
    await writeFile(join(dir, "import-summary.md"), summary);
  }
  const create = vi.fn(async (_: IssueCall) => ({}));
  const createComment = vi.fn(async (_: IssueCall) => ({}));
  const AsyncFunction = Object.getPrototypeOf(async () => {})
    .constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<unknown>;
  const script = new AsyncFunction(
    "require",
    "github",
    "context",
    "process",
    block(ISSUE, "script"),
  );
  await script(
    createRequire(import.meta.url),
    {
      paginate: async () => open,
      rest: { issues: { listForRepo: {}, create, createComment } },
    },
    {
      repo: { owner: "o", repo: "r" },
      serverUrl: "https://github.com",
      runId: 7,
      eventName: "schedule",
    },
    { env: { RUNNER_TEMP: dir } },
  );
  return { create, createComment };
}

const bodyOf = (call: Mock<(arg: IssueCall) => Promise<object>>) =>
  call.mock.calls[0]?.[0].body;

describe("import.yml's failure issue step, run over what the CLI writes", () => {
  const served: RunRecord["servedBefore"] = {
    database: { name: "nonprofits-data-b8", url: "libsql://b8.turso.io" },
    build_id: "b8",
    switched_at: "2026-09-03T06:20:00Z",
  };

  test("quotes a failed run's failure line and what it left serving, and says there is no rollback", async () => {
    const md = renderSummary(
      record({
        failure: "verify failed for build b9: orgs floor",
        servedBefore: served,
        servedAfter: served,
      }),
    );

    const { create } = await issueStep(md);

    const body = bodyOf(create);
    expect(body).toContain(
      "\n\n> **Failed:** verify failed for build b9: orgs floor\n>\n> **Nothing switched:** still serving nonprofits-data-b8, build b8",
    );
    expect(body).toContain("There is no rollback");
  });

  test("quotes a stopped run's stop line and its cleanup, not the failure the stop caused", async () => {
    const md = renderSummary(
      record({
        failure: "uploading failed: stopped: SIGINT",
        stop: { signal: "SIGINT", lines: ["stop cut off after 7 s"] },
        cleanup: "turso db destroy nonprofits-data-b9 --yes",
      }),
    );

    const { create } = await issueStep(md);

    const body = bodyOf(create);
    expect(body).toContain(
      "> **Stopped:** SIGINT\n>\n> **Cleanup:** `turso db destroy nonprofits-data-b9 --yes` removes",
    );
    expect(body).not.toContain("uploading failed");
  });

  test("says no summary was written when there is none, and comments on the open issue instead of opening another", async () => {
    const { create, createComment } = await issueStep(null, [
      { number: 12, title: "Monthly IRS import failed" },
    ]);

    expect(create).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledOnce();
    expect(bodyOf(createComment)).toContain(
      "> No run summary was written; the run's log says why.",
    );
    expect(createComment.mock.calls[0]?.[0]).toMatchObject({
      issue_number: 12,
    });
  });
});
