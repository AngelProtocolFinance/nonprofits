import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BMF_MIN_ORGS, BMF_URLS, importBmf } from "./bmf.ts";

const LOAD_FILE = fileURLToPath(
  new URL("../../../load/bmf.load.sql", import.meta.url),
);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { remote: { type: "boolean", default: false } },
  });
  const target = values.remote ? "remote" : "local";
  console.error(`importing the BMF into ${target} D1 via ${LOAD_FILE}`);
  const summary = await importBmf({
    urls: BMF_URLS,
    minOrgs: BMF_MIN_ORGS,
    out: LOAD_FILE,
    target: { remote: values.remote },
  });
  for (const file of summary.files) {
    console.log(`${file.url}  released ${file.releasedAt}  ${file.orgs} orgs`);
  }
  console.log(`${summary.orgs} orgs imported into ${target} D1`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
