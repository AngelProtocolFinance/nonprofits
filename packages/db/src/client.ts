import { type Client, createClient } from "@libsql/client";

/**
 * Where the app database is: a `libsql://` Turso URL with a read-write token
 * scoped to that one database, or a local `file:` or loopback `http:` URL,
 * which takes none.
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

export function isLocalUrl(url: string): boolean {
  return url.startsWith("file:") || url === ":memory:";
}

/** `turso dev`'s server, which takes no token. */
function isLoopbackHttp(url: string): boolean {
  const { protocol, hostname } = new URL(url);
  return (
    protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(hostname)
  );
}

/**
 * How long a local client waits on another connection's lock before failing
 * with SQLITE_BUSY, which the driver's default of 0 does at once. Only another
 * process can release the lock meanwhile: local calls block the event loop.
 */
const LOCAL_BUSY_TIMEOUT_MS = 5_000;

/** A client on a local `file:` database. */
export function localClient(url: string): Client {
  return createClient({ url, timeout: LOCAL_BUSY_TIMEOUT_MS });
}

/**
 * Puts a local database file in WAL mode, which the file keeps: readers then
 * never block the writer, as the api dev server would block the import.
 */
export async function useWal(local: Client): Promise<void> {
  await local.execute("PRAGMA journal_mode = WAL");
}

function connect(
  url: string,
  authToken: string | undefined,
  tokenVar: string,
): Client {
  if (isLocalUrl(url)) return localClient(url);
  if (authToken) return createClient({ url, authToken });
  if (isLoopbackHttp(url)) return createClient({ url });
  // the server would answer 401 on the first query instead
  throw new Error(`${tokenVar} is not set`);
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
