import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
});
