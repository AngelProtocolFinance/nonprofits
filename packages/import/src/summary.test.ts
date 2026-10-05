import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServedPointer } from "@nonprofits/db";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  type RunRecord,
  renderSummary,
  runRecord,
  summaryWriter,
} from "./summary.ts";

let work: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "summary-"));
});

afterAll(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

/** A refresh's record, `fields` set on it. */
function record(fields: Partial<RunRecord> = {}): RunRecord {
  return { ...runRecord(), ...fields };
}

/** The pointer naming `name`, holding `buildId`. */
const serving = (name: string, buildId: string): ServedPointer => ({
  database: { name, url: `libsql://${name}.turso.io` },
  build_id: buildId,
  switched_at: "2026-10-03T06:17:00Z",
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderSummary", () => {
  test("a stop line that spans lines stays one list item", () => {
    const md = renderSummary(
      record({
        stop: {
          signal: "SIGINT",
          lines: [
            "could not remove nonprofits-data-x (DELETE failed: x\n**Failed:** injected)",
          ],
        },
      }),
    );

    expect(md).toContain(
      "\n- could not remove nonprofits-data-x (DELETE failed: x **Failed:** injected)\n",
    );
    expect(md).not.toMatch(/^\*\*Failed:\*\*/m);
  });

  test("a failure's later lines sit in a fence their own backticks can't close", () => {
    const md = renderSummary(
      record({
        failure: "uploading failed: x\n```\n**Stopped:** injected",
      }),
    );

    expect(md).toContain(
      "**Failed:** uploading failed: x\n\n````\n```\n**Stopped:** injected\n````\n",
    );
  });

  test("a failure's later lines keep their last 100, saying how many were cut", () => {
    const output = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);

    const md = renderSummary(
      record({
        failure: ["uploading failed: x", ...output].join("\n"),
      }),
    );

    expect(md).toContain(
      "**Failed:** uploading failed: x\n\n```\n[200 earlier lines cut]\nline 201\nline 202\n",
    );
    expect(md).toContain("line 300\n```\n");
    expect(md).not.toContain("line 200\n");
  });

  test("a run whose errors quote 16 MiB leaves a summary of a few KiB, each piece of free text saying it was cut", () => {
    const mib = "x".repeat(1024 * 1024);
    const huge = Array.from({ length: 16 }, () => mib).join("\n");

    const md = renderSummary(
      record({
        failure: `uploading failed: ${mib}\n${huge}`,
        stop: { signal: "SIGTERM", lines: [`could not remove (${huge})`] },
        servedAfter: { unread: `reading failed: ${huge}` },
      }),
    );

    expect(Buffer.byteLength(md)).toBeLessThan(32 * 1024);
    const failed = md.split("\n").find((l) => l.startsWith("**Failed:**"));
    expect(failed).toMatch(
      /^\*\*Failed:\*\* uploading failed: x+… \[\d+ characters cut\]$/,
    );
    expect(md).toMatch(/^- could not remove \(x+… \[\d+ characters cut\]$/m);
    expect(md).toMatch(
      /^\| served after \| unknown \| pointer unread: reading failed: x+… \[\d+ characters cut\] \|$/m,
    );
    expect(md).toContain("```\n[");
    expect(md).toMatch(/^\[\d+ earlier lines cut\]$/m);
  });
});

describe("renderSummary's served-after row", () => {
  test("a pointer that couldn't be read shows as unknown with the reason, and a run that otherwise succeeded as done", () => {
    const md = renderSummary(
      record({ servedAfter: { unread: "SQLITE_BUSY: boom" } }),
    );

    expect(md).toContain("## irs refresh: done\n");
    expect(md).toContain(
      "| served after | unknown | pointer unread: SQLITE_BUSY: boom |\n",
    );
  });

  test("the reason's own pipes stay inside its table cell", () => {
    const md = renderSummary(record({ servedAfter: { unread: "a | b" } }));

    expect(md).toContain(
      "| served after | unknown | pointer unread: a \\| b |\n",
    );
  });

  test("a pointer that was read shows its database and build, and names them in the headline", () => {
    const md = renderSummary(
      record({ servedAfter: serving("nonprofits-data-b1", "b1") }),
    );

    expect(md).toContain(
      "## irs refresh: serving nonprofits-data-b1, build b1\n",
    );
    expect(md).toContain("| served after | nonprofits-data-b1 | b1 |\n");
  });

  test("a pointer that names no database yet shows as no database", () => {
    const md = renderSummary(
      record({
        servedBefore: { database: null, build_id: "empty", switched_at: "x" },
      }),
    );

    expect(md).toContain("| served before | no database | empty |\n");
  });
});

describe("renderSummary's served line", () => {
  const before = serving("nonprofits-data-b1", "b1");

  test.each<[string, Partial<RunRecord>]>([
    ["a failed run", { failure: "verify failed" }],
    ["a stopped run", { stop: { signal: "SIGINT", lines: [] } }],
  ])(
    "%s whose pointer reads back as before says nothing was switched",
    (_, fields) => {
      const md = renderSummary(
        record({ ...fields, servedBefore: before, servedAfter: before }),
      );

      expect(md).toContain(
        "**Nothing switched:** still serving nonprofits-data-b1, build b1\n",
      );
    },
  );

  test("a stopped run whose pointer moved, as a stop after the switch leaves it, says no such thing", () => {
    const md = renderSummary(
      record({
        stop: { signal: "SIGINT", lines: [] },
        servedBefore: before,
        servedAfter: serving("nonprofits-data-b2", "b2"),
      }),
    );

    expect(md).not.toContain("Nothing switched");
    expect(md).toContain("| served after | nonprofits-data-b2 | b2 |\n");
  });

  test("a run that succeeded, or a failed one whose pointer went unread, says no such thing", () => {
    const done = renderSummary(
      record({ servedBefore: before, servedAfter: before }),
    );
    const unread = renderSummary(
      record({
        failure: "x",
        servedBefore: before,
        servedAfter: { unread: "boom" },
      }),
    );

    expect(done).not.toContain("Nothing switched");
    expect(unread).not.toContain("Nothing switched");
  });
});

describe("renderSummary's cleanup line", () => {
  test("names the command that removes a database the run left, on a line of its own", () => {
    const md = renderSummary(
      record({ cleanup: "turso db destroy nonprofits-data-b1 --yes" }),
    );

    expect(md).toContain(
      "\n**Cleanup:** `turso db destroy nonprofits-data-b1 --yes` removes a database this run left behind, which holds storage until then\n",
    );
  });

  test("is absent when the run left none", () => {
    expect(renderSummary(record({ failure: "x" }))).not.toContain("Cleanup");
  });
});

describe("summaryWriter", () => {
  test("redacts a secret stored with surrounding whitespace by its trimmed value too", async () => {
    const file = join(work, "trimmed.md");

    summaryWriter(file, () => [" 0123abcd\n"])(
      record({
        failure: "POST /v1/upload answered 401: token 0123abcd rejected",
      }),
    );

    const md = await readFile(file, "utf8");
    expect(md).toContain("token [redacted] rejected");
    expect(md).not.toContain("0123abcd");
  });

  const SECRET = "S3CR3T0123abcd";
  /** Text that, after `lead` the summary puts before it, has `SECRET` across the 1,000-character cut a line of free text gets. */
  const straddling = (lead = "") =>
    `${"x".repeat(995 - lead.length)}${SECRET}${"y".repeat(100)}`;

  test.each<[string, Partial<RunRecord>]>([
    ["a failure's first line", { failure: straddling() }],
    ["a failure's later line", { failure: `upload failed\n${straddling()}` }],
    ["a stop's line", { stop: { signal: "SIGINT", lines: [straddling()] } }],
    [
      "a table cell",
      { servedAfter: { unread: straddling("pointer unread: ") } },
    ],
  ])(
    "redacts a secret across the cut in %s before clipping, leaving no prefix of it",
    async (name, fields) => {
      const file = join(work, `straddle-${name.replaceAll(" ", "-")}.md`);

      summaryWriter(file, () => [SECRET])(record(fields));

      const md = await readFile(file, "utf8");
      expect(md).not.toContain(SECRET.slice(0, 5));
      expect(md).toContain("[reda… [");
    },
  );

  test("clips a failure's first line on its redacted text, counting what the cut dropped of it", async () => {
    const file = join(work, "straddle-count.md");

    summaryWriter(file, () => [SECRET])(record({ failure: straddling() }));

    const md = await readFile(file, "utf8");
    expect(md).toContain(
      `**Failed:** ${"x".repeat(995)}[reda… [105 characters cut]\n`,
    );
  });

  test("redacts the secrets as they are when it writes, a token minted after it was made among them", async () => {
    const file = join(work, "late.md");
    const secrets: string[] = [];
    const write = summaryWriter(file, () => secrets);
    secrets.push("minted-later-0123abcd");

    write(record({ failure: "token minted-later-0123abcd rejected" }));

    expect(await readFile(file, "utf8")).toContain("token [redacted] rejected");
  });

  test("appends to what the file already holds", async () => {
    const file = join(work, "appended.md");
    await writeFile(file, "an earlier step's summary\n");

    summaryWriter(file, () => [])(record({ failure: "x" }));

    const md = await readFile(file, "utf8");
    expect(md.startsWith("an earlier step's summary\n## irs refresh")).toBe(
      true,
    );
    expect(md).toContain("**Failed:** x\n");
  });

  test("writes the first record only: a later one adds nothing", async () => {
    const file = join(work, "once.md");
    const write = summaryWriter(file, () => []);

    write(record({ failure: "the run's own failure" }));
    write(record({ stop: { signal: "SIGINT", lines: ["a stop's line"] } }));

    const md = await readFile(file, "utf8");
    expect(md.match(/^## /gm)).toHaveLength(1);
    expect(md).toContain("**Failed:** the run's own failure\n");
    expect(md).not.toContain("a stop's line");
  });

  test("an unwritable path is reported on stderr, naming it, and doesn't throw", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const file = join(work, "no-such-dir", "summary.md");

    expect(() => summaryWriter(file, () => [])(record())).not.toThrow();

    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^could not write the summary to ${file}: ENOENT`),
      ),
    );
  });
});
