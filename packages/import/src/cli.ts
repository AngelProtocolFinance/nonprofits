import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BMF_MIN_ORGS, BMF_URLS, importBmf } from "./bmf.ts";
import { EFILE_BASE_URL, EFILE_FLOORS, importEfile, percent } from "./efile.ts";
import { importList, LISTS, type ListName } from "./lists.ts";
import type { D1Target } from "./wrangler.ts";

const SOURCES = ["bmf", "pub78", "revocation", "epostcard", "efile"] as const;
type Source = (typeof SOURCES)[number];
/** What `all` loads, in order. Not efile: a full 990 run downloads ~10 GB and takes about an hour, so it is asked for by name. */
const ALL: readonly Source[] = ["bmf", "pub78", "revocation", "epostcard"];

const USAGE = `usage: node src/cli.ts <${SOURCES.join("|")}|all> [--remote] [--batch <XML_BATCH_ID>]...
  all      ${ALL.join(", ")}; efile only when named
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
      latestYear: new Date().getUTCFullYear(),
      ...(batches === undefined ? {} : { batches }),
      floors: EFILE_FLOORS,
      workDir: repoPath("data/efile"),
      out,
      target,
    });
    return [
      ...(summary.unpublished === null
        ? []
        : [`index_${summary.unpublished}.csv is not published yet`]),
      `release years read: ${summary.indexes.map((i) => i.year).join(", ")}`,
      ...summary.indexes.map(
        (i) => `${i.url}  released ${i.releasedAt}  ${i.rows} rows`,
      ),
      ...Object.entries(summary.skipped).map(
        ([type, rows]) => `not stored: ${rows} ${type} index rows`,
      ),
      ...summary.zips.map(
        (z) => `${z.url}  released ${z.releasedAt}  ${z.filings} filings`,
      ),
      ...Object.entries(summary.rejects).map(
        ([reason, ids]) =>
          `rejected ${ids.length} (${reason}): ${ids.slice(0, 10).join(", ")}${ids.length > 10 ? ", …" : ""}`,
      ),
      `efile: ${summary.filings} filings`,
      ...Object.entries(summary.yields).flatMap(([form, shares]) =>
        shares === null
          ? []
          : [
              `${form}: ${summary.returns[form as keyof typeof summary.returns]} selected, ${Object.entries(
                shares,
              )
                .map(([name, share]) => `${percent(share)} with ${name}`)
                .join(", ")}`,
            ],
      ),
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
    name === "all" ? ALL : name !== undefined && isSource(name) ? [name] : [];
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
