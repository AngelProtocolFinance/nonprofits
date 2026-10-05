import { openAsBlob } from "node:fs";
import { copyFile, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dataDbClient } from "@nonprofits/db/node";
import { Agent, fetch, type RequestInit, type Response } from "undici";
import {
  type DatabaseHost,
  errorMessage as message,
  onlyDataDatabase,
} from "./publish.ts";

/** Where a local refresh keeps its data databases: beside the dev app database, `.turso/app.db`, which git ignores. */
export const LOCAL_DATA_DIR = fileURLToPath(
  new URL("../../../.turso/data/", import.meta.url),
);

/** The settings that pick and reach a host. */
export interface HostEnv {
  /** The app database the pointer is in: a Turso Cloud one publishes to Turso, any other to local files. */
  TURSO_APP_DB_URL: string;
  TURSO_PLATFORM_TOKEN?: string | undefined;
  TURSO_ORG?: string | undefined;
  TURSO_GROUP?: string | undefined;
}

/**
 * The host whose databases the app database at `env.TURSO_APP_DB_URL` can
 * serve: Turso's Platform API for a Turso Cloud app database, which can't
 * open a local file; otherwise local files in `localDir`.
 */
export function databaseHostFor(env: HostEnv, localDir: string): DatabaseHost {
  const { protocol } = new URL(env.TURSO_APP_DB_URL);
  if (protocol !== "libsql:" && protocol !== "https:") {
    return localDatabases(localDir);
  }
  const {
    TURSO_PLATFORM_TOKEN: token,
    TURSO_ORG: org,
    TURSO_GROUP: group,
  } = env;
  if (!token || !org || !group) {
    const missing = Object.entries({
      TURSO_PLATFORM_TOKEN: token,
      TURSO_ORG: org,
      TURSO_GROUP: group,
    })
      .filter(([, value]) => !value)
      .map(([name]) => name);
    throw new Error(
      `${missing.join(", ")} not set: a Turso Cloud app database publishes through the Platform API`,
    );
  }
  return tursoDatabases({ token, org, group });
}

/**
 * Data databases as files in `dir`, named `<name>.db`, served by their
 * `file:` URLs: what a local refresh publishes to, and what the api's local
 * dev server then reads.
 */
export function localDatabases(dir: string): DatabaseHost {
  const path = (name: string) => join(dir, `${name}.db`);
  const files = (name: string) =>
    [path(name), `${path(name)}-wal`, `${path(name)}-shm`] as const;
  return {
    secrets: [],
    async create(name) {
      await mkdir(dir, { recursive: true });
      // "wx": fails if the file exists, as Turso's create does for a taken name
      await (await open(path(name), "wx")).close();
      return { name, url: pathToFileURL(path(name)).href };
    },
    async upload(database, file) {
      await uploadable(file);
      await copyFile(file, path(database.name));
    },
    open(database) {
      return dataDbClient(database.url, {});
    },
    async remove(name) {
      onlyDataDatabase(name);
      await Promise.all(files(name).map((f) => rm(f, { force: true })));
    },
    removeCommand(name) {
      return `rm -f ${files(name)
        .map((f) => `'${f}'`)
        .join(" ")}`;
    },
  };
}

export interface TursoPlatform {
  /** A Platform API token scoped to `group` with `db:create`, `db:mint-token` and `db:delete`. */
  token: string;
  /** The organization's slug. */
  org: string;
  /** The group data databases are created in. */
  group: string;
  /** Where requests go: Turso's own hosts unless a test serves them. */
  endpoints?: { api: string; upload: (hostname: string) => string };
}

/**
 * How long the token minted for a new database lasts: through its upload and
 * check, within a GitHub Actions job's 6 hours. Read-write, as the upload
 * writes; nothing keeps it once the publish ends.
 */
const DATABASE_TOKEN_EXPIRY = "6h";

const TURSO_ENDPOINTS = {
  api: "https://api.turso.tech",
  upload: (hostname: string) => `https://${hostname}/v1/upload`,
};

/** Data databases on Turso Cloud, made and removed through its Platform API. */
export function tursoDatabases({
  token,
  org,
  group,
  endpoints = TURSO_ENDPOINTS,
}: TursoPlatform): DatabaseHost {
  const secrets = [token];
  /** Each database's own token, by name: minted to upload it, then to check it. */
  const minted = new Map<string, string>();
  const api = async (
    method: string,
    path: string,
    { body, signal }: { body?: unknown; signal?: AbortSignal | undefined } = {},
  ) => {
    const response = await answered(`${endpoints.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
      signal: withTimeout(signal),
    });
    return (await response.json()) as unknown;
  };
  const createOnce = async (name: string, signal?: AbortSignal) => {
    const { database } = (await api(
      "POST",
      `/v1/organizations/${org}/databases`,
      { body: { name, group, seed: { type: "database_upload" } }, signal },
    )) as { database: { Hostname: string } };
    return { name, url: `libsql://${database.Hostname}` };
  };
  const remove = async (name: string) => {
    onlyDataDatabase(name);
    // 404: gone already, which is what removing it was for
    await answered(
      `${endpoints.api}/v1/organizations/${org}/databases/${name}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
        signal: withTimeout(undefined),
      },
      [404],
    );
  };
  const removeCommand = (name: string) => `turso db destroy ${name} --yes`;
  /** `failure` of a create that may have committed all the same, once `name` is removed, or why it couldn't be. */
  const removedInCase = async (failure: unknown, name: string) => {
    try {
      await remove(name);
      return new Error(
        `${message(failure)}; ${name} removed in case it was made`,
      );
    } catch (error) {
      return new Error(
        `${message(failure)}; could not remove ${name}, which may have been made (${message(error)}): \`${removeCommand(name)}\` removes it`,
      );
    }
  };
  return {
    secrets,
    async create(name, signal) {
      try {
        return await createOnce(name, signal);
      } catch (error) {
        // a 4xx is a refusal; with no answer, or a 5xx, the create may have committed
        if (error instanceof Refused && error.status < 500) throw error;
        throw await removedInCase(error, name);
      }
    },
    async upload(database, file, signal) {
      const { jwt } = (await api(
        "POST",
        `/v1/organizations/${org}/databases/${database.name}/auth/tokens?expiration=${DATABASE_TOKEN_EXPIRY}&authorization=full-access`,
        { signal },
      )) as { jwt: string };
      secrets.push(jwt);
      minted.set(database.name, jwt);
      // undici's 300 s headersTimeout runs from the last byte sent, and Turso
      // answers only once it has taken a ~2 GB file in: the caller's signal is the bound
      const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
      try {
        // a Blob streams from disk, and fetch sends its size as Content-Length
        await answered(endpoints.upload(new URL(database.url).hostname), {
          method: "POST",
          headers: { authorization: `Bearer ${jwt}` },
          body: await openAsBlob(file),
          signal: signal ?? null,
          dispatcher,
        });
      } finally {
        await dispatcher.close();
      }
    },
    open(database) {
      const jwt = minted.get(database.name);
      if (jwt === undefined) {
        throw new Error(`${database.name} has no token: open it after upload`);
      }
      return dataDbClient(database.url, { TURSO_DATA_DB_TOKEN: jwt });
    },
    remove,
    removeCommand,
  };
}

/** How long a Platform API call may take; the upload has its own bound, the caller's signal. */
const API_TIMEOUT_MS = 60_000;

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(API_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** A request Turso answered with a status other than the ones it was made for. */
class Refused extends Error {
  readonly status: number;
  constructor(text: string, status: number) {
    super(text);
    this.status = status;
  }
}

/**
 * `fetch`, failing unless the answer is a 2xx or one of `alsoOk`: the method,
 * the path (never the query or a header) and the status, then Turso's `error`
 * or the body.
 */
async function answered(
  url: string,
  init: RequestInit,
  alsoOk: readonly number[] = [],
): Promise<Response> {
  const response = await fetch(url, init);
  if (response.ok || alsoOk.includes(response.status)) return response;
  const text = await response.text();
  let reason = shortened(text);
  try {
    const { error } = JSON.parse(text) as { error?: unknown };
    if (typeof error === "string") reason = shortened(error);
  } catch {
    // not JSON: the body as sent
  }
  throw new Refused(
    `${init.method} ${new URL(url).pathname} answered ${response.status}: ${reason}`,
    response.status,
  );
}

/**
 * The most of a body a refusal quotes: a proxy's error page runs to
 * kilobytes, and a message is clipped to its first 1 000 characters
 * (`summary.ts` → `printable`), which would cut the cleanup command after it.
 */
const BODY_CHARS = 200;

/** `text` on one line, within `BODY_CHARS`, saying how much was cut. */
function shortened(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= BODY_CHARS) return line;
  return `${line.slice(0, BODY_CHARS)}… [${line.length - BODY_CHARS} characters cut]`;
}

/**
 * Fails, as Turso's upload answers 400, unless `file` is a SQLite file in the
 * format it takes: WAL, 4096-byte pages, auto-vacuum off, UTF-8. Read from the
 * header (sqlite.org/fileformat.html), so a local refresh fails on the files
 * a remote one would.
 */
async function uploadable(file: string): Promise<void> {
  const header = Buffer.alloc(100);
  const handle = await open(file, "r");
  try {
    await handle.read(header, 0, 100, 0);
  } finally {
    await handle.close();
  }
  const refused = (why: string) =>
    new Error(`${file} is not a database Turso's upload takes: ${why}`);
  if (header.toString("latin1", 0, 16) !== "SQLite format 3\0") {
    throw refused("not a SQLite file");
  }
  // 1 stands for 65536, which doesn't fit the field
  const pageSize =
    header.readUInt16BE(16) === 1 ? 65536 : header.readUInt16BE(16);
  if (pageSize !== 4096) throw refused(`${pageSize}-byte pages, not 4096`);
  if (header[18] !== 2 || header[19] !== 2) throw refused("not in WAL mode");
  // the largest root b-tree page, kept only with auto- or incremental vacuum
  if (header.readUInt32BE(52) !== 0) throw refused("auto-vacuum on");
  if (header.readUInt32BE(56) !== 1) throw refused("not UTF-8");
}
