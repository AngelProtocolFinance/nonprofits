import type { Client } from "@libsql/client";
import { readServedDatabase, switchServedDatabase } from "@nonprofits/db";
import { appDbFixture, dataDbFixture } from "@nonprofits/db/fixture";
import { type AppDbEnv, appDbClient } from "@nonprofits/db/node";

/** The app database the dev server serves from, and the data database its pointer names. */
export interface DevDatabases {
  appDb: Client;
  /** the served data database's name */
  serving: string;
  dispose(): Promise<void>;
}

/**
 * The app database `env.TURSO_APP_DB_URL` names, as `irs refresh` left it;
 * without one, fresh fixture databases in a temp directory, deleted on
 * dispose: the app database, migrated, pointing at a data database holding
 * `packages/db/fixtures/seed.sql`.
 */
export async function devDatabases(env: AppDbEnv): Promise<DevDatabases> {
  if (!env.TURSO_APP_DB_URL) return fixtureDatabases();
  const appDb = appDbClient(env);
  try {
    const { database } = await readServedDatabase(appDb);
    if (database === null) {
      throw new Error(
        `${env.TURSO_APP_DB_URL} serves no data database: run \`irs refresh\` first`,
      );
    }
    return {
      appDb,
      serving: database.name,
      dispose: async () => appDb.close(),
    };
  } catch (error) {
    appDb.close();
    throw error;
  }
}

async function fixtureDatabases(): Promise<DevDatabases> {
  const appDb = await appDbFixture();
  const dataDb = await dataDbFixture("fixture");
  const serving = "nonprofits-fixture";
  await switchServedDatabase(appDb.client, {
    expected: null,
    to: { name: serving, url: dataDb.url },
    buildId: "fixture",
  });
  return {
    appDb: appDb.client,
    serving,
    dispose: async () => {
      await appDb.dispose();
      await dataDb.dispose();
    },
  };
}
