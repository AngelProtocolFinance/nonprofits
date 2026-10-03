import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DATA_DB_BINDING, resetGenerationSql } from "@nonprofits/db";
import {
  type D1Target,
  localD1,
  QUERY_TIMEOUT_MS,
  wrangler,
} from "./wrangler.ts";

/** A body served whole, or a handler that writes the response itself. */
export type Route = string | Uint8Array | ((res: ServerResponse) => void);

/** Serves `routes` over loopback, each body with `lastModified` as its Last-Modified. */
export async function serve(
  routes: Map<string, Route>,
  lastModified: string,
): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const route = routes.get(req.url ?? "");
    if (route === undefined) {
      res.writeHead(404).end();
    } else if (typeof route === "function") {
      route(res);
    } else {
      res.writeHead(200, { "last-modified": lastModified }).end(route);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

/** The local data DB under `persistTo` that the load tests apply to. */
export function loadTarget(persistTo: string): D1Target {
  return { ops: localD1(persistTo), binding: DATA_DB_BINDING.a };
}

/** Builds an empty data generation in the local load DB under `persistTo`. */
export async function resetDataDb(persistTo: string): Promise<void> {
  await mkdir(persistTo, { recursive: true });
  const file = join(persistTo, "reset-generation.sql");
  await writeFile(file, resetGenerationSql("a", "test"));
  const { ops, binding } = loadTarget(persistTo);
  await ops.applyFile(binding, file);
}

/** Runs `sql` against the local load DB under `persistTo`; resolves with the last statement's rows. */
export function query<T>(persistTo: string, sql: string): Promise<T[]> {
  const { ops, binding } = loadTarget(persistTo);
  return ops.query<T>(binding, sql);
}

/** Applies the app migrations to the local `APP_DB` under `persistTo`, seeding the pointer at slot a, build `empty`. */
export async function migrateAppDb(persistTo: string): Promise<void> {
  await wrangler(
    [
      "d1",
      "migrations",
      "apply",
      "APP_DB",
      "--local",
      "--persist-to",
      persistTo,
    ],
    QUERY_TIMEOUT_MS,
  );
}
