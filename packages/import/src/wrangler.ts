import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// wrangler's exports map hides bin/, so resolve the manifest beside it
const WRANGLER_BIN = fileURLToPath(
  new URL(
    "bin/wrangler.js",
    pathToFileURL(
      createRequire(import.meta.url).resolve("wrangler/package.json"),
    ),
  ),
);
/** The worker's config owns the `DB` binding and the migrations dir. */
const WORKER_CONFIG = fileURLToPath(
  new URL("../../worker/wrangler.jsonc", import.meta.url),
);

/** Where a load is applied: local D1 state (wrangler's default dir unless `persistTo`), or the remote database. */
export type D1Target = { remote: true } | { remote: false; persistTo?: string };

/** Runs wrangler against the worker's config; resolves with stdout, rejects with wrangler's own output. */
export function wrangler(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [WRANGLER_BIN, ...args, "--config", WORKER_CONFIG],
      {
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `wrangler ${args.slice(0, 2).join(" ")} failed:\n${stderr || stdout}`,
              { cause: error },
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Applies a generated SQL file with `wrangler d1 execute --file`; D1 runs the whole file as one transaction. */
export async function applyLoad(file: string, target: D1Target): Promise<void> {
  const where = target.remote
    ? ["--remote", "--yes"]
    : [
        "--local",
        ...(target.persistTo ? ["--persist-to", target.persistTo] : []),
      ];
  await wrangler(["d1", "execute", "DB", ...where, "--file", file]);
}
