/** Splits a SQL file into statements; full-line `--` comments are dropped. */
export function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The slice of a D1 binding `runSql` needs, so node- and Worker-typed tests share it. */
interface Batchable<S> {
  prepare(sql: string): S;
  batch(statements: S[]): Promise<unknown>;
}

/** Runs a multi-statement SQL file as one D1 batch, as `wrangler d1 execute --file` would. */
export async function runSql<S>(db: Batchable<S>, sql: string): Promise<void> {
  await db.batch(statements(sql).map((s) => db.prepare(s)));
}
