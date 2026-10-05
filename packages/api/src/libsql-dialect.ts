import type { Client, InValue } from "@libsql/client";
import {
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";

const NO_TRANSACTIONS =
  "transactions are off on this dialect: better-auth runs with `transaction: false`";

/**
 * A Kysely dialect over a `@libsql/client` the app already holds, so
 * better-auth shares the app database's one client; `@libsql/kysely-libsql`
 * would install its own, older `@libsql/client` beside the catalog's.
 */
export function libsqlDialect(client: Client): Dialect {
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: {
      sql: string;
      parameters: readonly unknown[];
    }): Promise<QueryResult<R>> {
      const result = await client.execute({
        sql: compiled.sql,
        args: compiled.parameters as InValue[],
      });
      // plain objects: a libSQL row also carries its values by index
      const rows = result.rows.map(
        (row) =>
          Object.fromEntries(
            result.columns.map((column, i) => [column, row[i]]),
          ) as R,
      );
      return {
        rows,
        numAffectedRows: BigInt(result.rowsAffected),
        ...(result.lastInsertRowid === undefined
          ? {}
          : { insertId: result.lastInsertRowid }),
      };
    },
    streamQuery() {
      throw new Error("streaming queries are not supported on this dialect");
    },
  };
  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction() {
      throw new Error(NO_TRANSACTIONS);
    },
    async commitTransaction() {
      throw new Error(NO_TRANSACTIONS);
    },
    async rollbackTransaction() {
      throw new Error(NO_TRANSACTIONS);
    },
    async releaseConnection() {},
    // the client is the app's, closed by whoever opened it
    async destroy() {},
  };
  return {
    createDriver: () => driver,
    createQueryCompiler: () => new SqliteQueryCompiler(),
    createAdapter: () => new SqliteAdapter(),
    createIntrospector: (db) => new SqliteIntrospector(db),
  };
}
