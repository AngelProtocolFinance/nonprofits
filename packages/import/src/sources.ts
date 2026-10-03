import { BMF_MIN_ORGS, BMF_URLS, importBmf } from "./bmf.ts";
import {
  EFILE_BASE_URL,
  EFILE_FLOORS,
  type EfileImportOptions,
  importEfile,
  percent,
} from "./efile.ts";
import { importList, LISTS, type ListName } from "./lists.ts";
import type { D1Target } from "./wrangler.ts";

/** Every IRS source, in the order a full build loads them. */
export const SOURCES = [
  "bmf",
  "pub78",
  "revocation",
  "epostcard",
  "efile",
] as const;
export type Source = (typeof SOURCES)[number];

export function isSource(name: string): name is Source {
  return (SOURCES as readonly string[]).includes(name);
}

/** Where each source is fetched from and the floors its load must clear. */
export interface SourceConfig {
  bmf: { urls: readonly string[]; minOrgs: number };
  lists: Record<ListName, { url: string; minRows: number }>;
  efile: Omit<EfileImportOptions, "out" | "target">;
}

/** The IRS's published files and the production floors. */
export function irsSources(efile: {
  workDir: string;
  batches?: readonly string[];
}): SourceConfig {
  return {
    bmf: { urls: BMF_URLS, minOrgs: BMF_MIN_ORGS },
    lists: LISTS,
    efile: {
      baseUrl: EFILE_BASE_URL,
      latestYear: new Date().getUTCFullYear(),
      floors: EFILE_FLOORS,
      ...efile,
    },
  };
}

/**
 * Imports `source` into `target` as its own load, its SQL written to `out`;
 * resolves with the lines to report. Leaves the search index as it was.
 */
export async function loadSource(
  source: Source,
  config: SourceConfig,
  target: D1Target,
  out: string,
): Promise<string[]> {
  if (source === "efile") {
    const summary = await importEfile({ ...config.efile, out, target });
    return [
      ...(summary.unpublished === null
        ? []
        : [`index_${summary.unpublished}.csv is not published yet`]),
      `release years read: ${summary.indexes.map((i) => i.year).join(", ")} (${summary.windowReason})`,
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
        ([reason, ids]) => `rejected ${ids.length} (${reason}): ${some(ids)}`,
      ),
      ...(summary.runnersUp.loaded > 0
        ? [
            `runner-up filings loaded in their place: ${summary.runnersUp.loaded}`,
          ]
        : []),
      ...Object.entries(summary.runnersUp.rejects).map(
        ([reason, ids]) =>
          `rejected ${ids.length} runner-up filings too (${reason}): ${some(ids)}`,
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
    const summary = await importBmf({ ...config.bmf, out, target });
    return [
      ...summary.files.map(
        (f) => `${f.url}  released ${f.releasedAt}  ${f.orgs} orgs`,
      ),
      `bmf: ${summary.orgs} orgs`,
    ];
  }
  const summary = await importList(source, {
    ...config.lists[source],
    out,
    target,
  });
  return [
    `${summary.url}  released ${summary.releasedAt}  ${summary.rows} rows`,
  ];
}

/** The first 10 of `ids`, and an ellipsis for any more. */
function some(ids: readonly string[]): string {
  return `${ids.slice(0, 10).join(", ")}${ids.length > 10 ? ", …" : ""}`;
}
