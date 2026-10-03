import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BMF_MIN_ORGS, BMF_URLS, importBmf } from "./bmf.ts";
import {
  EFILE_BASE_URL,
  EFILE_MIN_YIELD,
  importEfile,
  percent,
  releaseYears,
} from "./efile.ts";
import { importList, LISTS, type ListName } from "./lists.ts";
import type { D1Target } from "./wrangler.ts";

/** In load order: the 990 filings attach to the orgs the others write. */
const SOURCES = ["bmf", "pub78", "revocation", "epostcard", "efile"] as const;
type Source = (typeof SOURCES)[number];

const USAGE = `usage: node src/cli.ts <${SOURCES.join("|")}|all> [--remote] [--batch <XML_BATCH_ID>]...
  --batch  efile only: load just the filings in this batch, keeping all others`;

function repoPath(path: string): string {
  return fileURLToPath(new URL(`../../../${path}`, import.meta.url));
}

function loadFile(source: Source): string {
  return repoPath(`load/${source}.load.sql`);
}

/** Imports one source as its own load; resolves with the lines to report. */
async function importSource(
  source: Source,
  target: D1Target,
  batches: readonly string[] | undefined,
): Promise<string[]> {
  const out = loadFile(source);
  if (source === "efile") {
    const summary = await importEfile({
      baseUrl: EFILE_BASE_URL,
      years: releaseYears(new Date()),
      ...(batches === undefined ? {} : { batches }),
      minYield: EFILE_MIN_YIELD,
      workDir: repoPath("data/efile"),
      out,
      target,
    });
    return [
      ...summary.indexes.map(
        (i) => `${i.url}  released ${i.releasedAt}  ${i.rows} rows`,
      ),
      ...Object.entries(summary.skipped).map(
        ([type, rows]) => `skipped ${rows} ${type} index rows`,
      ),
      ...summary.zips.map(
        (z) => `${z.url}  released ${z.releasedAt}  ${z.filings} filings`,
      ),
      `efile: ${summary.filings} filings, ${summary.forms990} Form 990s: ${percent(summary.yield.mission)} with a mission, ${percent(summary.yield.revenue)} with total revenue`,
    ];
  }
  if (source === "bmf") {
    const summary = await importBmf({
      urls: BMF_URLS,
      minOrgs: BMF_MIN_ORGS,
      out,
      target,
    });
    return [
      ...summary.files.map(
        (f) => `${f.url}  released ${f.releasedAt}  ${f.orgs} orgs`,
      ),
      `bmf: ${summary.orgs} orgs`,
    ];
  }
  const summary = await importList(source satisfies ListName, {
    ...LISTS[source],
    out,
    target,
  });
  return [
    `${summary.url}  released ${summary.releasedAt}  ${summary.rows} rows`,
  ];
}

function isSource(name: string): name is Source {
  return (SOURCES as readonly string[]).includes(name);
}

/** Each source commits on its own, so one failing in `all` still lets the rest load. */
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      remote: { type: "boolean", default: false },
      batch: { type: "string", multiple: true },
    },
    allowPositionals: true,
  });
  const [name, ...rest] = positionals;
  const sources =
    name === "all"
      ? SOURCES
      : name !== undefined && isSource(name)
        ? [name]
        : [];
  if (
    sources.length === 0 ||
    rest.length > 0 ||
    (values.batch !== undefined && name !== "efile")
  ) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const target: D1Target = { remote: values.remote };
  const where = values.remote ? "remote" : "local";
  const failed: Source[] = [];
  for (const source of sources) {
    console.error(
      `importing ${source} into ${where} D1 via ${loadFile(source)}`,
    );
    try {
      for (const line of await importSource(source, target, values.batch)) {
        console.log(line);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      failed.push(source);
    }
  }
  if (failed.length > 0) {
    console.error(`not imported: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
