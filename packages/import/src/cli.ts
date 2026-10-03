import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BMF_MIN_ORGS, BMF_URLS, importBmf } from "./bmf.ts";
import { importList, LISTS, type ListName } from "./lists.ts";
import type { D1Target } from "./wrangler.ts";

const SOURCES = ["bmf", "pub78", "revocation", "epostcard"] as const;
type Source = (typeof SOURCES)[number];

const USAGE = `usage: node src/cli.ts <${SOURCES.join("|")}|all> [--remote]`;

function loadFile(source: Source): string {
  return fileURLToPath(
    new URL(`../../../load/${source}.load.sql`, import.meta.url),
  );
}

/** Imports one source as its own load; resolves with the lines to report. */
async function importSource(
  source: Source,
  target: D1Target,
): Promise<string[]> {
  const out = loadFile(source);
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
    options: { remote: { type: "boolean", default: false } },
    allowPositionals: true,
  });
  const [name, ...rest] = positionals;
  const sources =
    name === "all"
      ? SOURCES
      : name !== undefined && isSource(name)
        ? [name]
        : [];
  if (sources.length === 0 || rest.length > 0) {
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
      for (const line of await importSource(source, target)) console.log(line);
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
