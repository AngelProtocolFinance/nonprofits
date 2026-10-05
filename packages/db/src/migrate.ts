import { readdir, readFile } from "node:fs/promises";
import type { Client } from "@libsql/client";

const APP_MIGRATIONS = new URL("../migrations/app/", import.meta.url);

const BOOKKEEPING_DDL = `CREATE TABLE IF NOT EXISTS app_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT`;

/**
 * Applies each `.sql` file in `dir` (`migrations/app/`) not yet recorded in
 * `app_migrations`, in file-name order, each in its own write transaction with
 * its record, so a failed file leaves nothing of itself behind and the next
 * run retries it. Returns the files applied; none on a database already
 * current.
 */
export async function migrateAppDb(
  app: Client,
  dir: URL = APP_MIGRATIONS,
): Promise<string[]> {
  await app.execute(BOOKKEEPING_DDL);
  const recorded = await app.execute("SELECT name FROM app_migrations");
  const applied = new Set(recorded.rows.map((r) => String(r.name)));
  const pending = (await readdir(dir))
    .filter((f) => f.endsWith(".sql") && !applied.has(f))
    .sort();
  for (const file of pending) {
    const sql = await readFile(new URL(file, dir), "utf8");
    const tx = await app.transaction("write");
    try {
      await tx.executeMultiple(sql);
      await tx.execute({
        sql: "INSERT INTO app_migrations (name, applied_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
        args: [file],
      });
      await tx.commit();
    } finally {
      tx.close();
    }
  }
  return pending;
}
