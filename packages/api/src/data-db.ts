import type { Client } from "@libsql/client";
import { holdsBuild, readDataMeta, readServedDatabase } from "@nonprofits/db";

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

/**
 * A resolver of the data database the app database's pointer names, read
 * again `POINTER_TTL_MS` after the last read. A database is served only once
 * its `data_meta` holds the pointer's build; otherwise, and while the pointer
 * can't be read, it throws.
 */
export function servedDataResolver(
  appDb: Client,
  openDataDb: (url: string) => Client,
): (nowMs: number) => Promise<ServedData> {
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

  return (nowMs) => {
    if (known !== undefined && nowMs - known.readAt < POINTER_TTL_MS) {
      return Promise.resolve(known);
    }
    reading ??= read(nowMs).finally(() => {
      reading = undefined;
    });
    return reading;
  };
}
