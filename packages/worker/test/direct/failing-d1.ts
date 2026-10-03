/** `db`, except statements matching `fails` throw as a storage outage would. */
export function failingD1(db: D1Database, fails: RegExp): D1Database {
  const outage = () => {
    throw new Error("D1_ERROR: simulated storage outage");
  };
  return {
    prepare: (sql: string) => (fails.test(sql) ? outage() : db.prepare(sql)),
    batch: (statements: D1PreparedStatement[]) => db.batch(statements),
    exec: (sql: string) => (fails.test(sql) ? outage() : db.exec(sql)),
    withSession: () => outage(),
    dump: () => outage(),
  } as D1Database;
}
