import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
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
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  type Mock,
  test,
  vi,
} from "vitest";
import {
  KEEPS_CLAIM_GREP,
  keepsClaim,
  RELEASE_LINE_SED,
  releaseCommand,
} from "./generation.ts";
import { type RunRecord, renderSummary, runRecord } from "./summary.ts";
import { remoteD1 } from "./wrangler.ts";

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

const IMPORT = step("Import");
const RELEASE = step("Release the claim of an import whose stop was cut off");
const RUN_SUMMARY = step("Run summary");
const ISSUE = step("Open or comment on the failure issue");

/** The path the import step has the CLI write its summary to, as the shell spells it. */
const SUMMARY_PATH = /--summary "([^"]+)"/.exec(IMPORT)?.[1] ?? "";

/** A remote refresh's record with `fields` set. */
const record = (fields: Partial<RunRecord> = {}): RunRecord => ({
  ...runRecord("refresh", true),
  ...fields,
});

const remote = remoteD1({ run: async () => "" });

let work: string;
let n = 0;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "workflow-"));
});

afterAll(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

describe("import.yml", () => {
  test("the steps that read the run summary read the path the import step writes it to", () => {
    expect(SUMMARY_PATH).toBe("$RUNNER_TEMP/import-summary.md");
    expect(block(RELEASE, "run")).toContain(`summary="${SUMMARY_PATH}"`);
    expect(block(RUN_SUMMARY, "run")).toContain(`summary="${SUMMARY_PATH}"`);
    expect(block(ISSUE, "script")).toContain(
      SUMMARY_PATH.replace("$RUNNER_TEMP", "${process.env.RUNNER_TEMP}"),
    );
  });

  test("the release step greps for a kept claim, then seds for the release line, with the CLI's own patterns", () => {
    const script = block(RELEASE, "run");
    const grep = script.indexOf(`grep -q "${KEEPS_CLAIM_GREP}" "$summary"`);
    const sed = script.indexOf(`sed -n '${RELEASE_LINE_SED}' "$summary"`);

    expect(grep).toBeGreaterThan(-1);
    expect(sed).toBeGreaterThan(-1);
    // a kept claim's line also matches the sed, so the grep has to come first
    expect(grep).toBeLessThan(sed);
  });
});

/** The release step's script run as GitHub runs it (`bash -eo pipefail`) over `summary`, `node` a stub that records its args and answers `node`. */
async function releaseStep(
  summary: string | null,
  node: { out?: string; exit?: number } = {},
) {
  const dir = join(work, `step-${++n}`);
  const bin = join(dir, "bin");
  const calls = join(dir, "calls");
  await mkdir(bin, { recursive: true });
  await writeFile(calls, "");
  await writeFile(
    join(bin, "node"),
    `#!/bin/sh\necho "$@" >> "$CALLS"\n[ -z "$NODE_OUT" ] || echo "$NODE_OUT"\nexit "\${NODE_EXIT:-0}"\n`,
  );
  await chmod(join(bin, "node"), 0o755);
  if (summary !== null) {
    await writeFile(join(dir, "import-summary.md"), summary);
  }
  const { code, stdout } = await new Promise<{ code: number; stdout: string }>(
    (resolve) => {
      execFile(
        "bash",
        ["-eo", "pipefail", "-c", block(RELEASE, "run")],
        {
          cwd: dir,
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            RUNNER_TEMP: dir,
            CALLS: calls,
            NODE_OUT: node.out ?? "",
            NODE_EXIT: String(node.exit ?? 0),
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
    code,
    stdout,
    calls: (await readFile(calls, "utf8")).split("\n").filter(Boolean),
  };
}

const CLI_RELEASE = (build: string) =>
  `packages/import/src/cli.ts release --remote --build ${build}`;

describe("import.yml's release step, run over what the CLI writes", () => {
  test("a cut-off stop's named release is run, for that build", async () => {
    const md = renderSummary(
      record({
        stop: {
          signal: "SIGINT",
          lines: [
            "stop cut off after 7 s",
            `${releaseCommand(remote, "b2")} clears build b2's claim if it is still held`,
          ],
        },
      }),
    );

    const step = await releaseStep(md);

    expect(step.code).toBe(0);
    expect(step.calls).toStrictEqual([CLI_RELEASE("b2")]);
  });

  test("a release that failed in the run is run again, for that build", async () => {
    const md = renderSummary(
      record({
        stop: {
          signal: "SIGTERM",
          lines: [
            `could not release build b3's claim (wrangler d1 execute failed: x); ${releaseCommand(remote, "b3")} clears it, or it lapses with its lease`,
          ],
        },
      }),
    );

    const step = await releaseStep(md);

    expect(step.calls).toStrictEqual([CLI_RELEASE("b3")]);
  });

  test("only the first release a summary names is run", async () => {
    const md = renderSummary(
      record({
        stop: {
          signal: "SIGINT",
          lines: [
            `${releaseCommand(remote, "b2")} clears build b2's claim if it is still held`,
            `${releaseCommand(remote, "b3")} clears build b3's claim if it is still held`,
          ],
        },
      }),
    );

    expect((await releaseStep(md)).calls).toStrictEqual([CLI_RELEASE("b2")]);
  });

  test("a kept claim is left held, though its line names a release too", async () => {
    const md = renderSummary(
      record({
        failure: "wrangler d1 execute timed out after 7200000 ms",
        keptClaims: [{ buildId: "b1", binding: "DATA_DB_B" }],
      }),
    );
    // the line the release step must not act on
    expect(keepsClaim("b1", "DATA_DB_B")).toContain(
      "irs release --remote --build b1 clears",
    );

    const step = await releaseStep(md);

    expect(step.code).toBe(0);
    expect(step.calls).toStrictEqual([]);
    expect(step.stdout).toContain("::warning title=Claim kept::");
  });

  test("a run with a kept claim and a release to make releases nothing", async () => {
    const md = renderSummary(
      record({
        keptClaims: [{ buildId: "b1", binding: "DATA_DB_B" }],
        stop: {
          signal: "SIGINT",
          lines: [
            `${releaseCommand(remote, "b2")} clears build b2's claim if it is still held`,
          ],
        },
      }),
    );

    expect((await releaseStep(md)).calls).toStrictEqual([]);
  });

  test("no summary, or one naming no claim, releases nothing", async () => {
    const none = await releaseStep(null);
    const bare = await releaseStep(renderSummary(record({ failure: "x" })));

    expect(none.code).toBe(0);
    expect(none.calls).toStrictEqual([]);
    expect(none.stdout).toContain("no run summary");
    expect(bare.code).toBe(0);
    expect(bare.calls).toStrictEqual([]);
    expect(bare.stdout).toContain("names no claim");
  });

  const STOPPED = renderSummary(
    record({
      stop: {
        signal: "SIGINT",
        lines: [
          `${releaseCommand(remote, "b2")} clears build b2's claim if it is still held`,
        ],
      },
    }),
  );

  test("a release that finds no claim holding is a pass: the stop's own release landed", async () => {
    const step = await releaseStep(STOPPED, {
      out: "release: build b2 holds no claim in remote D1",
      exit: 1,
    });

    expect(step.code).toBe(0);
  });

  test("any other release failure fails the step with its exit code", async () => {
    const step = await releaseStep(STOPPED, {
      out: "wrangler d1 execute failed: boom",
      exit: 1,
    });

    expect(step.code).toBe(1);
    expect(step.stdout).toContain("boom");
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
  test("quotes a failed run's failure line", async () => {
    const md = renderSummary(
      record({
        failure: "verify failed for build b9 in DATA_DB_B: orgs floor",
      }),
    );

    const { create } = await issueStep(md);

    expect(bodyOf(create)).toContain(
      "\n\n> **Failed:** verify failed for build b9 in DATA_DB_B: orgs floor",
    );
  });

  test("quotes a stopped run's stop line and each kept claim, not the failure the kill caused", async () => {
    const md = renderSummary(
      record({
        failure: "flip failed: wrangler d1 execute stopped",
        stop: { signal: "SIGINT", lines: ["released build b1's claim"] },
        keptClaims: [{ buildId: "b4", binding: "DATA_DB_B" }],
      }),
    );

    const { create } = await issueStep(md);

    const body = bodyOf(create);
    expect(body).toContain(
      `> **Stopped:** SIGINT\n>\n> **Claim kept:** ${keepsClaim("b4", "DATA_DB_B")}`,
    );
    expect(body).not.toContain("flip failed");
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
