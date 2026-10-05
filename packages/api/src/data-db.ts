import type { Client } from "@libsql/client";
import { holdsBuild, readDataMeta, readServedDatabase } from "@nonprofits/db";
import { logFailure } from "./log.ts";

/** The data database a request reads, and the build it holds. */
export interface ServedData {
  client: Client;
  buildId: string;
}

/** The pointer names no database yet: the first import hasn't switched to one. */
export class DataNotLoaded extends Error {
  constructor() {
    super("served_database names no database: never built");
  }
}

/** How long a read of the pointer is served before it is read again. */
export const POINTER_TTL_MS = 30_000;

/** The served data database, resolved through the pointer and cached. */
export interface ServedDataResolver {
  /** The database to read at `nowMs`. */
  serve(nowMs: number): Promise<ServedData>;
  /** `client` failed a read: the next `serve` reads the pointer again and opens a fresh client. */
  forget(client: Client): void;
}

/**
 * A resolver of the data database the app database's pointer names, read
 * again `POINTER_TTL_MS` after the last read. A database is served only once
 * its `data_meta` holds the pointer's build. A read past the TTL that fails,
 * or names a database that isn't servable, keeps the database served last and
 * reads again on the next request; with none served, or once it is forgotten,
 * it throws.
 */
export function servedDataResolver(
  appDb: Client,
  openDataDb: (url: string) => Client,
): ServedDataResolver {
  let known: (ServedData & { url: string; readAt: number }) | undefined;
  // concurrent requests past the TTL share one read, so they open one client
  let reading: Promise<ServedData> | undefined;

  async function read(nowMs: number): Promise<ServedData> {
    const { database, build_id: buildId } = await readServedDatabase(appDb);
    if (database === null) throw new DataNotLoaded();
    if (known?.url === database.url && known.buildId === buildId) {
      known.readAt = nowMs;
      return known;
    }
    const client = openDataDb(database.url);
    try {
      if (!holdsBuild(buildId, await readDataMeta(client))) {
        throw new Error(`${database.name} does not hold build ${buildId}`);
      }
    } catch (error) {
      client.close();
      throw error;
    }
    // the client it replaces stays open: requests already reading it finish
    known = { client, buildId, url: database.url, readAt: nowMs };
    return known;
  }

  async function readOrKeep(nowMs: number): Promise<ServedData> {
    try {
      return await read(nowMs);
    } catch (error) {
      if (known === undefined) throw error;
      // readAt stays put, so the next request reads again
      logFailure("data_pointer_unservable", error);
      return known;
    }
  }

  return {
    serve(nowMs) {
      if (known !== undefined && nowMs - known.readAt < POINTER_TTL_MS) {
        return Promise.resolve(known);
      }
      reading ??= readOrKeep(nowMs).finally(() => {
        reading = undefined;
      });
      return reading;
    },
    forget(client) {
      // not closed: other requests may still be reading it
      if (known?.client === client) known = undefined;
    },
  };
}
