import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { wrangler } from "./wrangler.ts";

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

/** Applies the migrations to a fresh local D1 under `persistTo`. */
export async function migrate(persistTo: string): Promise<void> {
  await wrangler([
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--persist-to",
    persistTo,
  ]);
}

/** Runs `sql` against the local D1 under `persistTo`; resolves with the last statement's rows. */
export async function query<T>(persistTo: string, sql: string): Promise<T[]> {
  const out = await wrangler([
    "d1",
    "execute",
    "DB",
    "--local",
    "--persist-to",
    persistTo,
    "--json",
    "--command",
    sql,
  ]);
  const results = JSON.parse(out) as { results: T[] }[];
  return results.at(-1)?.results ?? [];
}
