import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Client, createClient } from "@libsql/client";
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

async function localDb(file: string): Promise<LocalDb> {
  const dir = await mkdtemp(join(tmpdir(), "nonprofits-db-"));
  const url = pathToFileURL(join(dir, file)).href;
  const client = createClient({ url });
  return {
    url,
    client,
    async dispose() {
      client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A fresh app database with every app migration applied. */
export async function appDbFixture(): Promise<LocalDb> {
  const db = await localDb("app.db");
  await migrateAppDb(db.client);
  return db;
}

const SEED = new URL("../fixtures/seed.sql", import.meta.url);

/** A finished data database holding `buildId`: the data schema, `fixtures/seed.sql`'s rows, and their search index. */
export async function dataDbFixture(buildId: string): Promise<LocalDb> {
  const db = await localDb("data.db");
  await createDataDatabase(db.client);
  await db.client.executeMultiple(await readFile(SEED, "utf8"));
  await finishDataDatabase(db.client, buildId);
  return db;
}
