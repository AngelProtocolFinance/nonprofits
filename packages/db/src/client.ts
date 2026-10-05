import { type Client, createClient } from "@libsql/client";

/**
 * Where the app database is: a `libsql://` Turso URL with a read-write token
 * scoped to that one database, or a local `file:` URL, which takes none.
 */
export interface AppDbEnv {
  TURSO_APP_DB_URL?: string | undefined;
  TURSO_APP_DB_TOKEN?: string | undefined;
}

/**
 * The token every data database is read with: read-only and scoped to the
 * group, so a database the import creates next month needs no new secret.
 */
export interface DataDbEnv {
  TURSO_DATA_DB_TOKEN?: string | undefined;
}

function isLocal(url: string): boolean {
  return url.startsWith("file:") || url === ":memory:";
}

function connect(
  url: string,
  authToken: string | undefined,
  tokenVar: string,
): Client {
  if (isLocal(url)) return createClient({ url });
  // the server would answer 401 on the first query instead
  if (!authToken) throw new Error(`${tokenVar} is not set`);
  return createClient({ url, authToken });
}

/** A client on the app database `env` names: auth, usage, and the served-database pointer. */
export function appDbClient(env: AppDbEnv): Client {
  // no local default here: a deploy missing the url fails, not serves an empty file
  if (!env.TURSO_APP_DB_URL) throw new Error("TURSO_APP_DB_URL is not set");
  return connect(
    env.TURSO_APP_DB_URL,
    env.TURSO_APP_DB_TOKEN,
    "TURSO_APP_DB_TOKEN",
  );
}

/** A client on the data database at `url`, the pointer's `database_url`. */
export function dataDbClient(url: string, env: DataDbEnv): Client {
  return connect(url, env.TURSO_DATA_DB_TOKEN, "TURSO_DATA_DB_TOKEN");
}
