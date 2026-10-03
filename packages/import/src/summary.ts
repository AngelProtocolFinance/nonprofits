import { appendFileSync } from "node:fs";
import type { Pointer } from "@nonprofits/db";
import { percent } from "./efile.ts";
import { type Check, readPointer } from "./generation.ts";
import type { Loaded } from "./sources.ts";
import type { D1Ops } from "./wrangler.ts";

export interface Step {
  name: string;
  seconds: number;
  ok: boolean;
}

/** What a refresh or rollback did, filled in as it runs, so a failed or stopped run still reports how far it got. */
export interface RunRecord {
  command: "refresh" | "rollback";
  remote: boolean;
  /** `performance.now()` when the record was made. */
  startedAt: number;
  /** Set once the run has ended. */
  seconds: number | null;
  /** What the pointer served when the run first read it. */
  servedBefore: Pointer | null;
  /** Read back from the pointer once the run ended, or why it couldn't be. Null after a stop, whose own lines say. */
  servedAfter: Pointer | { unread: string } | null;
  steps: Step[];
  loads: Loaded[];
  checks: Check[];
  failure: string | null;
  /** A SIGINT or SIGTERM, and the lines its cleanup reported. */
  stop: { signal: string; lines: string[] } | null;
}

export function runRecord(
  command: RunRecord["command"],
  remote: boolean,
): RunRecord {
  return {
    command,
    remote,
    startedAt: performance.now(),
    seconds: null,
    servedBefore: null,
    servedAfter: null,
    steps: [],
    loads: [],
    checks: [],
    failure: null,
    stop: null,
  };
}

/**
 * Runs `run`, recording its failure in `record`, then reads what the pointer
 * serves into it and hands it to `write`; rethrows the run's failure after.
 * A run a signal stopped is left to the stop, which writes its own summary.
 */
export async function summarized<T>(
  ops: D1Ops,
  record: RunRecord,
  write: (record: RunRecord) => void,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    record.failure = message(error);
    throw error;
  } finally {
    if (record.stop === null) {
      record.servedAfter = await readPointer(ops).catch((error: unknown) => ({
        unread: message(error),
      }));
      finish(record);
      write(record);
    }
  }
}

/** Stamps the run's duration on `record`. */
export function finish(record: RunRecord): void {
  record.seconds = (performance.now() - record.startedAt) / 1000;
}

/**
 * Appends a record's summary to `path` once, every one of `secrets` in it
 * replaced: a wrangler error can quote the account id in an API path. A
 * failed write is reported on stderr and doesn't fail the run.
 */
export function summaryWriter(
  path: string,
  secrets: readonly (string | undefined)[],
): (record: RunRecord) => void {
  let written = false;
  return (record) => {
    if (written) return;
    written = true;
    let text = renderSummary(record);
    for (const secret of secrets) {
      // an empty value would be "found" between every two characters
      if (secret) text = text.replaceAll(secret, "[redacted]");
    }
    try {
      appendFileSync(path, text);
    } catch (error) {
      console.error(
        `could not write the summary to ${path}: ${message(error)}`,
      );
    }
  };
}

/** The record as GitHub-flavoured markdown; a failure's first line on a line of its own, starting `**Failed:**`. */
export function renderSummary(record: RunRecord): string {
  const out: string[] = [`## ${headline(record)}`, ""];
  if (record.stop !== null) {
    out.push(
      `**Stopped:** ${record.stop.signal}`,
      "",
      ...record.stop.lines.map((line) => `- ${line}`),
      "",
    );
  }
  if (record.failure !== null) {
    const [first, ...more] = record.failure.split("\n");
    out.push(`**Failed:** ${first}`, "");
    if (more.length > 0) out.push("```", ...more, "```", "");
  }
  out.push(...served(record));
  if (record.loads.length > 0) out.push(...sources(record.loads));
  if (record.checks.length > 0) {
    out.push(
      "### Verify",
      "",
      row("check", "result", "detail", "time"),
      row("---", "---", "---", "---"),
      ...record.checks.map((c) =>
        row(c.name, c.ok ? "ok" : "FAILED", c.detail, seconds(c.seconds)),
      ),
      "",
    );
  }
  out.push(
    "### Steps",
    "",
    row("step", "time"),
    row("---", "---"),
    ...record.steps.map((s) =>
      row(
        s.name,
        s.ok ? seconds(s.seconds) : `failed after ${seconds(s.seconds)}`,
      ),
    ),
    ...(record.seconds === null ? [] : [row("total", seconds(record.seconds))]),
    "",
  );
  return `${out.join("\n")}\n`;
}

function headline(record: RunRecord): string {
  const run = `irs ${record.command} (${record.remote ? "remote" : "local"} D1)`;
  if (record.stop !== null) return `${run}: stopped by ${record.stop.signal}`;
  if (record.failure !== null) return `${run}: failed`;
  const after = record.servedAfter;
  return after === null || "unread" in after
    ? `${run}: done`
    : `${run}: serving slot ${after.active}, build ${after.build_id}`;
}

function served(record: RunRecord): string[] {
  const rows: string[] = [];
  if (record.servedBefore !== null) {
    rows.push(
      row(
        "served before",
        record.servedBefore.active,
        record.servedBefore.build_id,
      ),
    );
  }
  const after = record.servedAfter;
  if (after !== null) {
    rows.push(
      "unread" in after
        ? row("served after", "unknown", `pointer unread: ${after.unread}`)
        : row("served after", after.active, after.build_id),
    );
  }
  if (rows.length === 0) return [];
  return [row("", "slot", "build"), row("---", "---", "---"), ...rows, ""];
}

function sources(loads: readonly Loaded[]): string[] {
  const out = [
    "### Sources",
    "",
    row("source", "rows", "released"),
    row("---", "---", "---"),
  ];
  for (const load of loads) {
    if (load.source === "bmf") {
      const dates = new Set(load.summary.files.map((f) => f.releasedAt));
      out.push(row("bmf", `${load.summary.orgs} orgs`, [...dates].join(", ")));
    } else if (load.source === "efile") {
      const years = load.summary.indexes.map((i) => i.year).join(", ");
      out.push(row("efile", `${load.summary.filings} filings`, years));
    } else {
      out.push(
        row(load.source, `${load.summary.rows} rows`, load.summary.releasedAt),
      );
    }
  }
  out.push("");
  for (const load of loads) {
    if (load.source !== "efile") continue;
    const { indexes, windowReason, returns, yields } = load.summary;
    out.push(
      `Release years read: ${indexes.map((i) => i.year).join(", ")} (${windowReason})`,
      "",
      row("form", "returns", "yields"),
      row("---", "---", "---"),
    );
    for (const [form, shares] of Object.entries(yields)) {
      if (shares === null) continue;
      out.push(
        row(
          form,
          `${returns[form as keyof typeof returns]} returns`,
          Object.entries(shares)
            .map(([name, share]) => `${percent(share)} with ${name}`)
            .join(", "),
        ),
      );
    }
    out.push("");
  }
  return out;
}

/** A markdown table row; a cell's `|` escaped and its line breaks flattened, so free text can't break the table. */
function row(...cells: string[]): string {
  return `| ${cells.map((c) => c.replaceAll("|", "\\|").replaceAll("\n", " ")).join(" | ")} |`;
}

function seconds(s: number): string {
  return `${s.toFixed(1)} s`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
