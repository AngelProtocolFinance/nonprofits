import { Hono } from "hono";
import { createApp } from "./src/app.ts";
import { logFailure } from "./src/log.ts";
import { problem } from "./src/problem.ts";
import { missingEnv, productionDeps } from "./src/production.ts";

/** Answers every request with a 503 naming `missing`, and opens no database. */
function misconfigured(missing: string[]) {
  const detail = `Set ${missing.join(", ")} in the project's environment variables, then redeploy.`;
  logFailure("server_misconfigured", detail);
  return new Hono().all("*", () =>
    problem(503, "server_misconfigured", detail),
  );
}

const missing = missingEnv(process.env);

/** The deployed app; `build.ts` bundles this file for Vercel. */
export default missing.length === 0
  ? createApp(productionDeps(process.env))
  : misconfigured(missing);
