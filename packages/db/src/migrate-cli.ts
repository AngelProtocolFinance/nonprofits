// Applies the app migrations to the database TURSO_APP_DB_URL names, with
// TURSO_APP_DB_TOKEN when it is remote; without a url, to the local dev file.
import { mkdir } from "node:fs/promises";
import { appDbClient } from "./client.ts";
import { migrateAppDb } from "./migrate.ts";

const LOCAL_APP_DB = new URL("../../../.turso/app.db", import.meta.url);

const env = process.env;
if (!env.TURSO_APP_DB_URL) {
  await mkdir(new URL(".", LOCAL_APP_DB), { recursive: true });
}
const app = appDbClient({
  TURSO_APP_DB_URL: env.TURSO_APP_DB_URL || LOCAL_APP_DB.href,
  TURSO_APP_DB_TOKEN: env.TURSO_APP_DB_TOKEN,
});
try {
  const applied = await migrateAppDb(app);
  for (const file of applied) console.log(`applied ${file}`);
  if (applied.length === 0) console.log("app database is current");
} finally {
  app.close();
}
