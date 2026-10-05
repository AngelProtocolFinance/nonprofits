import { appendFileSync } from "node:fs";
import type { Pointer } from "@nonprofits/db";
import { percent } from "./efile.ts";
import { keepsClaim, readPointer } from "./generation.ts";
import type { Loaded } from "./sources.ts";
import type { Check } from "./verify.ts";
import type { D1Ops } from "./wrangler.ts";

export interface Step {
  name: string;
  seconds: number;
  ok: boolean;
}

/** A claim a run left held: `binding`'s remote import may still be running. */
export interface KeptClaim {
  buildId: string;
  binding: string;
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
  keptClaims: KeptClaim[];
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
    keptClaims: [],
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
      const servedAfter = await readPointer(ops).catch((error: unknown) => ({
        unread: message(error),
      }));
      // a signal during the read: its stop writes the summary, once its cleanup is done
      if (record.stop === null) {
        record.servedAfter = servedAfter;
        finish(record);
        write(record);
      }
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
  secrets: Secrets,
): (record: RunRecord) => void {
  let written = false;
  return (record) => {
    if (written) return;
    written = true;
    try {
      appendFileSync(path, renderSummary(record, secrets));
    } catch (error) {
      console.error(
        `could not write the summary to ${path}: ${message(error)}`,
      );
    }
  };
}

type Secrets = readonly (string | undefined)[];

/** `text` with every one of `secrets` replaced by `[redacted]`. */
function redact(text: string, secrets: Secrets): string {
  // trimmed too: whitespace stored around a secret needn't appear where it is quoted
  for (const secret of secrets.flatMap((s) => [s, s?.trim()])) {
    // an empty value would be "found" between every two characters
    if (secret) text = text.replaceAll(secret, "[redacted]");
  }
  return text;
}

/**
 * Free text as the CLI prints it, kept as a summary keeps a failure: every
 * one of `secrets` replaced, the first line clipped as the `**Failed:**` line
 * is and the rest as the block under it.
 */
export function printable(text: string, secrets: Secrets): string {
  return clipped(text, redactingClip(secrets)).join("\n");
}

/**
 * The record as GitHub-flavoured markdown; a failure's first line on a line
 * of its own, starting `**Failed:**`, and each kept claim on one starting
 * `**Claim kept:**`. Every one of `secrets` is replaced, in free text before
 * it is clipped, so a cut can't leave part of one.
 */
export function renderSummary(
  record: RunRecord,
  secrets: Secrets = [],
): string {
  const clip = redactingClip(secrets);
  const row = tableRow(clip);
  const out: string[] = [`## ${headline(record)}`, ""];
  if (record.stop !== null) {
    out.push(
      `**Stopped:** ${record.stop.signal}`,
      "",
      ...record.stop.lines.map((line) => `- ${clip(line)}`),
      "",
    );
  }
  if (record.failure !== null) {
    const [first, ...more] = clipped(record.failure, clip);
    out.push(`**Failed:** ${first}`, "");
    if (more.length > 0) out.push(...fenced(more), "");
  }
  for (const { buildId, binding } of record.keptClaims) {
    out.push(`**Claim kept:** ${clip(keepsClaim(buildId, binding))}`, "");
  }
  out.push(...served(record, row));
  if (record.loads.length > 0) out.push(...sources(record.loads, row));
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
  // the unclipped text too: the headline's build id, the release years' reason
  return redact(`${out.join("\n")}\n`, secrets);
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

function served(record: RunRecord, row: Row): string[] {
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

function sources(loads: readonly Loaded[], row: Row): string[] {
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
      const indexes = load.summary.indexes
        .map((i) => `${i.year}: ${i.releasedAt}`)
        .join(", ");
      out.push(row("efile", `${load.summary.filings} filings`, indexes));
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

type Row = (...cells: string[]) => string;

/** A markdown table row; a cell through `clip` and its `|` escaped, so free text can't break the table. */
function tableRow(clip: Clip): Row {
  return (...cells) =>
    `| ${cells.map((c) => clip(c).replaceAll("|", "\\|")).join(" | ")} |`;
}

/**
 * The most of a block of free text the summary keeps, its last lines: a
 * wrangler failure can quote 16 MiB of output, and GitHub drops a step
 * summary over 1 MiB.
 */
const BLOCK_LINES = 100;
const BLOCK_BYTES = 16 * 1024;
/** The most of one line of free text the summary keeps, its start. */
const LINE_CHARS = 1_000;

/** The end of `lines`, each through `clip`, within `BLOCK_LINES` and `BLOCK_BYTES`, led by how many were cut. */
function tail(lines: readonly string[], clip: Clip): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < BLOCK_LINES; i--) {
    const line = clip(lines[i] ?? "");
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > BLOCK_BYTES) break;
    kept.unshift(line);
  }
  const cut = lines.length - kept.length;
  return cut === 0 ? kept : [`[${cut} earlier lines cut]`, ...kept];
}

/** `text`'s first line through `clip`, then the tail of the rest. */
function clipped(text: string, clip: Clip): [string, ...string[]] {
  const [first = "", ...more] = text.split(/\r\n|\r|\n/);
  return [clip(first), ...tail(more, clip)];
}

type Clip = (text: string) => string;

/** `clipLine` once every one of `secrets` is replaced, so a cut can't leave part of one. */
function redactingClip(secrets: Secrets): Clip {
  return (text) => clipLine(redact(text, secrets));
}

/** `text` on one line, so it can't start a line a reader of the summary matches, within `LINE_CHARS`, saying how much was cut. */
function clipLine(text: string): string {
  const line = text.replace(/\r\n|\r|\n/g, " ");
  if (line.length <= LINE_CHARS) return line;
  return `${line.slice(0, LINE_CHARS)}… [${line.length - LINE_CHARS} characters cut]`;
}

/** `lines` as a code block, its fence longer than any run of backticks in them. */
function fenced(lines: readonly string[]): string[] {
  const longest = Math.max(
    0,
    ...lines
      .flatMap((line) => line.match(/`+/g) ?? [])
      .map((run) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [fence, ...lines, fence];
}

function seconds(s: number): string {
  return `${s.toFixed(1)} s`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
