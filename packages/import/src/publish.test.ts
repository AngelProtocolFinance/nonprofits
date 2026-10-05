import {
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@libsql/client";
import {
  holdsBuild,
  readDataMeta,
  readServedDatabase,
  type ServedDatabase,
  switchServedDatabase,
} from "@nonprofits/db";
import {
  appDbFixture,
  dataDbFixture,
  type LocalDb,
} from "@nonprofits/db/fixture";
import { dataDbClient } from "@nonprofits/db/node";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { localDatabases } from "./database-host.ts";
import {
  type DatabaseHost,
  type PublishOptions,
  publishDataFile,
} from "./publish.ts";
import { renderSummary, runRecord } from "./summary.ts";
import { type Counts, readCounts } from "./verify.ts";

/** A built file: what `buildDataFile` hands publish. */
interface Built {
  file: string;
  buildId: string;
  counts: Counts;
}

let work: string;
let app: LocalDb;
let host: DatabaseHost;
/** Every line publish logged, and every message it threw, in this test. */
let printed: string[];
/** Every message publish threw, in this test: what a run summary reports as its failure. */
let thrown: string[];

/** Stands in for a minted database token: every host these tests use holds it, and quotes it in its failures. */
const TOKEN = "eyJhbGciOiJFZERTQSJ9.c2VjcmV0LXRva2Vu.Zk3pQ9xLr7TuV2yWm5NaB8";

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "publish-"));
  app = await appDbFixture();
  host = holdingToken(localDatabases(join(work, "databases")));
  printed = [];
  thrown = [];
});

afterEach(async () => {
  expect(printed.filter((line) => line.includes(TOKEN))).toStrictEqual([]);
  // no secrets handed to the summary: the message alone must be clean
  const summaries = thrown.map((failure) =>
    renderSummary({ ...runRecord("refresh", false), failure }),
  );
  expect(summaries.filter((text) => text.includes(TOKEN))).toStrictEqual([]);
  await app?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

/** A finished data file holding `buildId`, in Turso's upload format, as the build leaves it. */
async function built(buildId: string): Promise<Built> {
  const fixture = await dataDbFixture(buildId);
  try {
    const counts = await readCounts(
      async <T>(sql: string) =>
        (await fixture.client.execute(sql)).rows as unknown as T[],
    );
    await fixture.client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    fixture.client.close();
    const file = join(work, `${buildId.replaceAll(":", "")}.db`);
    await copyFile(fileURLToPath(fixture.url), file);
    return { file, buildId, counts };
  } finally {
    await fixture.dispose();
  }
}

/**
 * `inner`, holding `TOKEN` as a secret and quoting it in every failure, as an
 * HTTP client's error can quote the request that carried it.
 */
function holdingToken(inner: DatabaseHost): DatabaseHost {
  const quoting =
    <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await run(...args);
      } catch (error) {
        throw new Error(`${String(error)} (Authorization: Bearer ${TOKEN})`, {
          cause: error instanceof Error ? error.cause : undefined,
        });
      }
    };
  return {
    secrets: [...inner.secrets, TOKEN],
    create: quoting(inner.create),
    upload: quoting(inner.upload),
    open: inner.open,
    remove: quoting(inner.remove),
    removeCommand: inner.removeCommand,
  };
}

/** Publishes `build` through `through`, every line it logs and message it throws kept in `printed`. */
async function publish(
  build: Built,
  through: DatabaseHost = host,
  more: Partial<Pick<PublishOptions, "app" | "signal" | "sleep">> = {},
) {
  try {
    return await publishDataFile({
      app: app.client,
      host: through,
      ...build,
      sleep: async () => {},
      ...more,
      log: (line) => printed.push(line),
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    printed.push(text);
    thrown.push(text);
    throw error;
  }
}

/** The pointer as read, and the bytes of the database it serves. */
async function servedState() {
  const pointer = await readServedDatabase(app.client);
  const bytes = pointer.database
    ? await readFile(fileURLToPath(pointer.database.url))
    : null;
  return { pointer, bytes };
}

/** The databases the local host holds, by name. */
async function databaseNames(): Promise<string[]> {
  const files = await readdir(join(work, "databases"));
  return files.filter((f) => f.endsWith(".db")).map((f) => f.slice(0, -3));
}

describe("publishing a verified file", () => {
  test("serves the new database, removes the previous one, and the api's read opens the new one", async () => {
    const first = await publish(await built("2026-09-01T00:00:00Z"));
    const second = await publish(await built("2026-10-01T00:00:00Z"));

    const pointer = await readServedDatabase(app.client);
    expect(pointer.database).toStrictEqual(second.database);
    expect(pointer.build_id).toBe("2026-10-01T00:00:00Z");
    expect(second.previous).toStrictEqual(first.database);
    expect(await exists(first.database)).toBe(false);

    // the api's read: the pointer's url, opened as the api opens it
    const served = dataDbClient(pointer.database?.url ?? "", {});
    try {
      expect(holdsBuild(pointer.build_id, await readDataMeta(served))).toBe(
        true,
      );
    } finally {
      served.close();
    }
  });
});

test("the previous database outlives the api's cached pointer: removed only after the grace period, once the switch serves", async () => {
  const first = await publish(await built("2026-09-01T00:00:00Z"));
  const during: { ms: number; pointer: string | undefined; held: boolean }[] =
    [];
  await publish(await built("2026-10-01T00:00:00Z"), host, {
    async sleep(ms) {
      during.push({
        ms,
        pointer: (await readServedDatabase(app.client)).database?.name,
        held: await exists(first.database),
      });
    },
  });
  expect(during).toStrictEqual([
    { ms: 60_000, pointer: "nonprofits-data-20261001t000000z", held: true },
  ]);
  expect(await exists(first.database)).toBe(false);
});

test("a stop during the grace period leaves the previous database, with the command that removes it", async () => {
  const first = await publish(await built("2026-09-01T00:00:00Z"));
  const stop = new AbortController();
  const second = await publish(await built("2026-10-01T00:00:00Z"), host, {
    signal: stop.signal,
    async sleep(_, signal) {
      stop.abort(new Error("SIGTERM"));
      signal?.throwIfAborted();
    },
  });
  expect((await readServedDatabase(app.client)).database).toStrictEqual(
    second.database,
  );
  expect(await exists(first.database)).toBe(true);
  expect(second.cleanup).toBe(
    localDatabases(join(work, "databases")).removeCommand(first.database.name),
  );
});

test("a previous database that won't go is left beside the served one, loudly, with the command that removes it", async () => {
  const first = await publish(await built("2026-09-01T00:00:00Z"));
  const local = localDatabases(join(work, "databases"));
  const stuck = holdingToken({
    ...local,
    async remove(name) {
      if (name === first.database.name)
        throw new Error("503 Service Unavailable");
      await local.remove(name);
    },
  });
  const second = await publish(await built("2026-10-01T00:00:00Z"), stuck);

  expect((await readServedDatabase(app.client)).database).toStrictEqual(
    second.database,
  );
  expect(await exists(first.database)).toBe(true);
  const command = local.removeCommand(first.database.name);
  expect(second.cleanup).toBe(command);
  expect(printed).toContainEqual(
    expect.stringMatching(
      new RegExp(`^WARNING: could not remove ${first.database.name}.*503`),
    ),
  );
  expect(printed.some((line) => line.includes(command))).toBe(true);
});

test("a previous database not named as a data database is never removed", async () => {
  // what a hand-edited pointer could name: the delete token reaches the whole group
  const local = localDatabases(join(work, "databases"));
  const foreign = await local.create("nonprofits-app");
  await local.upload(foreign, (await built("2026-09-01T00:00:00Z")).file);
  await switchServedDatabase(app.client, {
    expected: null,
    to: foreign,
    buildId: "2026-09-01T00:00:00Z",
  });

  const published = await publish(await built("2026-10-01T00:00:00Z"));
  expect(published.previous).toStrictEqual(foreign);
  expect(await exists(foreign)).toBe(true);
  expect(published.cleanup).toBeNull();
  expect(printed).toContainEqual(
    expect.stringMatching(/^WARNING: not removing nonprofits-app/),
  );
});

describe("a publish that fails", () => {
  let before: Awaited<ReturnType<typeof servedState>>;
  let served: string[];

  beforeEach(async () => {
    await publish(await built("2026-09-01T00:00:00Z"));
    before = await servedState();
    served = await databaseNames();
  });

  /** Asserts the run failed with `message`, and left the pointer, the served database and the host as they were. */
  async function leavesServingAsItWas(run: Promise<unknown>, message: RegExp) {
    await expect(run).rejects.toThrow(message);
    expect(await servedState()).toStrictEqual(before);
    expect(await databaseNames()).toStrictEqual(served);
  }

  test("at upload removes the new database", async () => {
    const refused: DatabaseHost = holdingToken({
      ...localDatabases(join(work, "databases")),
      async upload() {
        throw new Error("400 Bad Request: invalid database file");
      },
    });
    await leavesServingAsItWas(
      publish(await built("2026-10-01T00:00:00Z"), refused),
      /upload.*400 Bad Request/,
    );
  });

  test("whose new database won't go either names the command that removes it", async () => {
    const local = localDatabases(join(work, "databases"));
    const name = "nonprofits-data-20261001t000000z";
    const failing = holdingToken({
      ...local,
      async upload() {
        throw new Error("400 Bad Request");
      },
      async remove() {
        throw new Error("503 Service Unavailable");
      },
    });
    await expect(
      publish(await built("2026-10-01T00:00:00Z"), failing),
    ).rejects.toThrow(
      `nothing switched, but could not remove ${name} (Error: 503 Service Unavailable`,
    );
    expect(printed.some((l) => l.includes(local.removeCommand(name)))).toBe(
      true,
    );
    expect(await servedState()).toStrictEqual(before);
  });

  test("stopped mid-upload removes the new database", async () => {
    const stop = new AbortController();
    const local = localDatabases(join(work, "databases"));
    const stopped = holdingToken({
      ...local,
      async upload(database, file) {
        await local.upload(database, file);
        stop.abort(new Error("SIGTERM"));
      },
    });
    await leavesServingAsItWas(
      publish(await built("2026-10-01T00:00:00Z"), stopped, {
        signal: stop.signal,
      }),
      /stopped: SIGTERM.*removed, nothing switched/,
    );
  });

  test("at upload names what the fetch failure was caused by, its token redacted", async () => {
    const timedOut = holdingToken({
      ...localDatabases(join(work, "databases")),
      async upload() {
        throw new TypeError("fetch failed", {
          cause: Object.assign(
            new Error(`Headers Timeout Error, sent with ${TOKEN}`),
            { code: "UND_ERR_HEADERS_TIMEOUT" },
          ),
        });
      },
    });
    await leavesServingAsItWas(
      publish(await built("2026-10-01T00:00:00Z"), timedOut),
      /upload.*fetch failed.*\(UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error, sent with \[redacted\]\)/,
    );
  });

  test("at the remote check removes the new database", async () => {
    // an upload that lands another build's file: the check reads what arrived
    const stale = await built("2026-08-01T00:00:00Z");
    const local = localDatabases(join(work, "databases"));
    const misdelivered = holdingToken({
      ...local,
      upload: (database) => local.upload(database, stale.file),
    });
    await leavesServingAsItWas(
      publish(await built("2026-10-01T00:00:00Z"), misdelivered),
      /check.*holds build 2026-08-01T00:00:00Z, not 2026-10-01T00:00:00Z/,
    );
  });

  /** The local host, its upload running `sql` on the copy once it has landed. */
  function landingWith(sql: string): DatabaseHost {
    const local = localDatabases(join(work, "databases"));
    return holdingToken({
      ...local,
      async upload(database, file) {
        await local.upload(database, file);
        const copy = local.open(database);
        try {
          await copy.executeMultiple(sql);
        } finally {
          copy.close();
        }
      },
    });
  }

  test("when the copy doesn't answer the Red Cross", async () => {
    await leavesServingAsItWas(
      publish(
        await built("2026-10-01T00:00:00Z"),
        landingWith(
          "PRAGMA foreign_keys = OFF; DELETE FROM orgs WHERE ein = '530196605';",
        ),
      ),
      /check.*has no org 530196605/,
    );
  });

  test("when the copy's counts differ from the file's", async () => {
    await leavesServingAsItWas(
      publish(
        await built("2026-10-01T00:00:00Z"),
        landingWith(
          "DELETE FROM programs WHERE rowid = (SELECT min(rowid) FROM programs)",
        ),
      ),
      /check.*programs: 2, the file's 3/,
    );
  });

  /**
   * The app database, its batch (the switch's one call) failing as a dropped
   * connection does: after the write committed, or before it. With
   * `unreadable`, every read after that failure fails too.
   */
  function failingSwitch(
    when: "after commit" | "before commit",
    { unreadable = false } = {},
  ): Client {
    let failed = false;
    return new Proxy(app.client, {
      get(target, key, receiver) {
        if (key === "batch") {
          return async (...args: Parameters<Client["batch"]>) => {
            if (when === "after commit") await target.batch(...args);
            failed = true;
            throw new Error("connection reset");
          };
        }
        if (key === "execute") {
          return (...args: Parameters<Client["execute"]>) => {
            if (failed && unreadable) throw new Error("connection refused");
            return target.execute(...args);
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
  }

  test("at a switch that committed before failing serves the new database, as a switch would", async () => {
    const published = await publish(await built("2026-10-01T00:00:00Z"), host, {
      app: failingSwitch("after commit"),
    });
    const pointer = await readServedDatabase(app.client);
    expect(pointer.database).toStrictEqual(published.database);
    expect(pointer.build_id).toBe("2026-10-01T00:00:00Z");
    expect(await databaseNames()).toStrictEqual([published.database.name]);
  });

  test("at a switch that failed before committing removes the new database", async () => {
    await leavesServingAsItWas(
      publish(await built("2026-10-01T00:00:00Z"), host, {
        app: failingSwitch("before commit"),
      }),
      /switch.*connection reset.*removed, nothing switched/,
    );
  });

  test("at a switch whose outcome can't be read keeps the new database, naming the command that removes it", async () => {
    const name = "nonprofits-data-20261001t000000z";
    await expect(
      publish(await built("2026-10-01T00:00:00Z"), host, {
        app: failingSwitch("before commit", { unreadable: true }),
      }),
    ).rejects.toThrow(
      `${name} kept: unless the pointer names it, \`${localDatabases(join(work, "databases")).removeCommand(name)}\` removes it`,
    );
    expect(await databaseNames()).toContain(name);
  });

  test("by losing the switch race removes the new database and switches nothing", async () => {
    // another publish switches to its own database while this one uploads
    const racer = await built("2026-10-02T00:00:00Z");
    const local = localDatabases(join(work, "databases"));
    let raced: Awaited<ReturnType<typeof servedState>> | undefined;
    let held: string[] = [];
    const racing = holdingToken({
      ...local,
      async upload(database, file) {
        await local.upload(database, file);
        const theirs = await local.create("racer");
        await local.upload(theirs, racer.file);
        await switchServedDatabase(app.client, {
          expected: before.pointer.database?.name ?? null,
          to: theirs,
          buildId: racer.buildId,
        });
        raced = await servedState();
        held = (await databaseNames()).filter((n) => n !== database.name);
      },
    });
    await expect(
      publish(await built("2026-10-01T00:00:00Z"), racing),
    ).rejects.toThrow(/another publish switched to racer first/);
    expect(raced?.pointer.database?.name).toBe("racer");
    expect(await servedState()).toStrictEqual(raced);
    expect(await databaseNames()).toStrictEqual(held);
  });
});

test("a file over the cap fails before any call to the host, naming its size and the cap", async () => {
  const build = await built("2026-10-01T00:00:00Z");
  // sparse: the size the cap reads, without the disk
  await truncate(build.file, 2_500_000_000);
  const calls: string[] = [];
  const counting = new Proxy(host, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(key));
        return value.apply(target, args);
      };
    },
  });
  await expect(publish(build, counting)).rejects.toThrow(
    /2\.50 GB \(2500000000 bytes\).*over the 2\.40 GB \(2400000000 bytes\)/,
  );
  expect(calls).toStrictEqual([]);
});

async function exists(database: ServedDatabase): Promise<boolean> {
  return readFile(fileURLToPath(database.url)).then(
    () => true,
    () => false,
  );
}
