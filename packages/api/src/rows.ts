import type { ResultSet } from "@libsql/client";

/** A batch result's rows as `T`: the driver types each column as any SQLite value. */
export function rowsOf<T>(rs: ResultSet | undefined): T[] {
  return (rs?.rows ?? []) as unknown as T[];
}
