import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** A remote refresh's record, `fields` set on it. */
function record(fields: Partial<RunRecord> = {}): RunRecord {
  return { ...runRecord("refresh", true), ...fields };
}

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
            "could not release build b1's claim (wrangler d1 execute failed: x\n**Failed:** injected)",
          ],
        },
      }),
    );

    expect(md).toContain(
      "\n- could not release build b1's claim (wrangler d1 execute failed: x **Failed:** injected)\n",
    );
    expect(md).not.toMatch(/^\*\*Failed:\*\*/m);
  });

  test("a failure's later lines sit in a fence their own backticks can't close", () => {
    const md = renderSummary(
      record({
        failure: "wrangler d1 execute failed: x\n```\n**Stopped:** injected",
      }),
    );

    expect(md).toContain(
      "**Failed:** wrangler d1 execute failed: x\n\n````\n```\n**Stopped:** injected\n````\n",
    );
  });

  test("a failure's later lines keep their last 100, saying how many were cut", () => {
    const output = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);

    const md = renderSummary(
      record({
        failure: ["wrangler d1 execute failed: x", ...output].join("\n"),
      }),
    );

    expect(md).toContain(
      "**Failed:** wrangler d1 execute failed: x\n\n```\n[200 earlier lines cut]\nline 201\nline 202\n",
    );
    expect(md).toContain("line 300\n```\n");
    expect(md).not.toContain("line 200\n");
  });

  test("a run whose wrangler printed 16 MiB leaves a summary of a few KiB, each piece of free text saying it was cut", () => {
    const mib = "x".repeat(1024 * 1024);
    const huge = Array.from({ length: 16 }, () => mib).join("\n");

    const md = renderSummary(
      record({
        failure: `wrangler d1 execute failed: ${mib}\n${huge}`,
        stop: { signal: "SIGTERM", lines: [`could not release (${huge})`] },
        servedAfter: { unread: `wrangler d1 execute failed: ${huge}` },
      }),
    );

    expect(Buffer.byteLength(md)).toBeLessThan(32 * 1024);
    const failed = md.split("\n").find((l) => l.startsWith("**Failed:**"));
    expect(failed).toMatch(
      /^\*\*Failed:\*\* wrangler d1 execute failed: x+… \[\d+ characters cut\]$/,
    );
    expect(md).toMatch(/^- could not release \(x+… \[\d+ characters cut\]$/m);
    expect(md).toMatch(
      /^\| served after \| unknown \| pointer unread: wrangler d1 execute failed: x+… \[\d+ characters cut\] \|$/m,
    );
    expect(md).toContain("```\n[");
    expect(md).toMatch(/^\[\d+ earlier lines cut\]$/m);
  });
});

describe("renderSummary's served-after row", () => {
  test("a pointer that couldn't be read shows as unknown with the reason, and a run that otherwise succeeded as done", () => {
    const md = renderSummary(
      record({ servedAfter: { unread: "wrangler d1 execute failed: boom" } }),
    );

    expect(md).toContain("## irs refresh (remote D1): done\n");
    expect(md).toContain(
      "| served after | unknown | pointer unread: wrangler d1 execute failed: boom |\n",
    );
  });

  test("the reason's own pipes stay inside its table cell", () => {
    const md = renderSummary(record({ servedAfter: { unread: "a | b" } }));

    expect(md).toContain(
      "| served after | unknown | pointer unread: a \\| b |\n",
    );
  });

  test("a pointer that was read shows its slot and build, and names them in the headline", () => {
    const md = renderSummary(
      record({
        servedAfter: { active: "b", build_id: "b1", flipped_at: "2026-10-03" },
      }),
    );

    expect(md).toContain(
      "## irs refresh (remote D1): serving slot b, build b1\n",
    );
    expect(md).toContain("| served after | b | b1 |\n");
  });
});

describe("summaryWriter", () => {
  test("redacts a secret stored with surrounding whitespace by its trimmed value too", async () => {
    const file = join(work, "trimmed.md");

    summaryWriter(file, [" 0123abcd\n"])(
      record({
        failure:
          "A request to the Cloudflare API (/accounts/0123abcd/d1/database/x/import) failed.",
      }),
    );

    const md = await readFile(file, "utf8");
    expect(md).toContain("/accounts/[redacted]/d1/");
    expect(md).not.toContain("0123abcd");
  });

  test("appends to what the file already holds", async () => {
    const file = join(work, "appended.md");
    await writeFile(file, "an earlier step's summary\n");

    summaryWriter(file, [])(record({ failure: "x" }));

    const md = await readFile(file, "utf8");
    expect(md.startsWith("an earlier step's summary\n## irs refresh")).toBe(
      true,
    );
    expect(md).toContain("**Failed:** x\n");
  });

  test("writes the first record only: a later one adds nothing", async () => {
    const file = join(work, "once.md");
    const write = summaryWriter(file, []);

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

    expect(() => summaryWriter(file, [])(record())).not.toThrow();

    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^could not write the summary to ${file}: ENOENT`),
      ),
    );
  });
});
