import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Client } from "@libsql/client";
import { localClient, useWal } from "./client.ts";
import { createDataDatabase, finishDataDatabase } from "./data-database.ts";
import { migrateAppDb } from "./migrate.ts";

/** A database file in its own temp directory, for one test's use. */
export interface LocalDb {
  /** the `file:` URL, for code that connects by URL itself */
  url: string;
  client: Client;
  /** Closes the client and deletes the directory. */
  dispose(): Promise<void>;
}

/**
 * A local database file in WAL mode, as the migrate command leaves the dev
 * app file, after `setUp` has run on it; disposed again if `setUp` throws.
 */
async function localDb(
  file: string,
  setUp: (client: Client) => Promise<void>,
): Promise<LocalDb> {
  const dir = await mkdtemp(join(tmpdir(), "nonprofits-db-"));
  const url = pathToFileURL(join(dir, file)).href;
  let client: Client | undefined;
  const dispose = async () => {
    client?.close();
    await rm(dir, { recursive: true, force: true });
  };
  try {
    client = localClient(url);
    await useWal(client);
    await setUp(client);
    return { url, client, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** A fresh app database with every app migration applied. */
export async function appDbFixture(): Promise<LocalDb> {
  return localDb("app.db", async (client) => {
    await migrateAppDb(client);
  });
}

const SEED = new URL("../fixtures/seed.sql", import.meta.url);

/** A finished data database holding `buildId`: the data schema, `fixtures/seed.sql`'s rows, and their search index. */
export async function dataDbFixture(buildId: string): Promise<LocalDb> {
  return localDb("data.db", async (client) => {
    await createDataDatabase(client);
    await client.executeMultiple(await readFile(SEED, "utf8"));
    await finishDataDatabase(client, buildId);
  });
}
