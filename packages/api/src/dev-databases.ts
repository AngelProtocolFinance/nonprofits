import { access } from "node:fs/promises";
import type { Client } from "@libsql/client";
import { readServedDatabase, switchServedDatabase } from "@nonprofits/db";
import { appDbFixture, dataDbFixture } from "@nonprofits/db/fixture";
import { type AppDbEnv, appDbClient } from "@nonprofits/db/node";

/** The app database the dev server serves from, and the data database its pointer names. */
export interface DevDatabases {
  appDb: Client;
  /** the served data database's name */
  serving: string;
  /** the app database's URL, or that it is a fixture */
  from: string;
  dispose(): Promise<void>;
}

/** Where `pnpm --filter @nonprofits/db migrate` and `irs refresh` put the app database when TURSO_APP_DB_URL is unset. */
const LOCAL_APP_DB = new URL("../../../.turso/app.db", import.meta.url);

/**
 * The app database `env.TURSO_APP_DB_URL` names, which must serve a data
 * database; without one, `localAppDb` once its pointer names a data database
 * (`irs refresh` published one); else fresh fixture databases in a temp
 * directory, deleted on dispose: the app database, migrated, pointing at a
 * data database holding `packages/db/fixtures/seed.sql`.
 */
export async function devDatabases(
  env: AppDbEnv,
  localAppDb: URL = LOCAL_APP_DB,
): Promise<DevDatabases> {
  if (env.TURSO_APP_DB_URL) {
    const served = await servedFrom(env);
    if (served === null) {
      throw new Error(
        `${env.TURSO_APP_DB_URL} serves no data database: run \`irs refresh\` first`,
      );
    }
    return served;
  }
  const local = (await exists(localAppDb))
    ? await servedFrom({ TURSO_APP_DB_URL: localAppDb.href })
    : null;
  return local ?? fixtureDatabases();
}

async function exists(file: URL): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

/** The app database `env` names, or null while its pointer names no data database. */
async function servedFrom(env: AppDbEnv): Promise<DevDatabases | null> {
  const appDb = appDbClient(env);
  try {
    const { database } = await readServedDatabase(appDb);
    if (database === null) {
      appDb.close();
      return null;
    }
    return {
      appDb,
      serving: database.name,
      from: String(env.TURSO_APP_DB_URL),
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
    from: "fixture databases",
    dispose: async () => {
      await appDb.dispose();
      await dataDb.dispose();
    },
  };
}
