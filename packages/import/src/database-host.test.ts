import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dataDbClient } from "@nonprofits/db/node";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  databaseHostFor,
  localDatabases,
  tursoDatabases,
} from "./database-host.ts";

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "database-host-"));
});

afterEach(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

/** A SQLite file at `name` in the work dir, after `pragmas`, holding one table. */
async function sqliteFile(name: string, pragmas: string): Promise<string> {
  const path = join(work, name);
  const db = dataDbClient(pathToFileURL(path).href, {});
  try {
    await db.executeMultiple(
      `${pragmas} CREATE TABLE t (x); PRAGMA wal_checkpoint(TRUNCATE);`,
    );
  } finally {
    db.close();
  }
  return path;
}

describe("local databases", () => {
  test.each([
    ["not in WAL mode", "PRAGMA journal_mode = DELETE;", /not in WAL mode/],
    [
      "with 8192-byte pages",
      "PRAGMA page_size = 8192; PRAGMA journal_mode = WAL;",
      /8192-byte pages, not 4096/,
    ],
    [
      "with auto-vacuum on",
      "PRAGMA auto_vacuum = FULL; PRAGMA journal_mode = WAL;",
      /auto-vacuum on/,
    ],
  ])("refuse an upload %s, as Turso's does", async (_, pragmas, refusal) => {
    const host = localDatabases(join(work, "databases"));
    const file = await sqliteFile("bad.db", pragmas);
    const database = await host.create("nonprofits-data-x");
    await expect(host.upload(database, file)).rejects.toThrow(refusal);
  });

  test("refuse to remove a database not named as a data database", async () => {
    const host = localDatabases(join(work, "databases"));
    const app = await host.create("nonprofits-app");
    await expect(host.remove("nonprofits-app")).rejects.toThrow(
      "not removing nonprofits-app: only a database named nonprofits-data-… is the import's",
    );
    expect(existsSync(fileURLToPath(app.url))).toBe(true);
  });

  test("take an upload in Turso's format", async () => {
    const host = localDatabases(join(work, "databases"));
    const file = await sqliteFile(
      "good.db",
      "PRAGMA page_size = 4096; PRAGMA auto_vacuum = NONE; PRAGMA journal_mode = WAL;",
    );
    const database = await host.create("nonprofits-data-x");
    await host.upload(database, file);
    const copy = await host.open(database);
    try {
      const rs = await copy.execute("SELECT name FROM sqlite_schema");
      expect(rs.rows.map((r) => r.name)).toStrictEqual(["t"]);
    } finally {
      copy.close();
    }
  });
});

/** One request the fake Platform API received. */
interface Received {
  method: string;
  url: string;
  authorization: string | undefined;
  contentLength: string | undefined;
  body: Buffer;
}

/** What the fake answers a request with: a status and a JSON body, or a text one. */
type Answer = (request: Received) => {
  status: number;
  json?: unknown;
  text?: string;
};

const PLATFORM_TOKEN = "platform-token-Zk3pQ9xLr7TuV2yWm5NaB8cDe1Fg";
const MINTED = "minted-jwt-eyJhbGciOiJFZERTQSJ9.c2VjcmV0";

/** Answers as the docs say Turso does, to a request made as the docs say. */
const turso: Answer = ({ method, url }) => {
  if (method === "POST" && url === "/v1/organizations/acme/databases") {
    return {
      status: 200,
      json: {
        database: {
          DbId: "1",
          Hostname: "nonprofits-data-x-acme.aws-us-east-1.turso.io",
          Name: "nonprofits-data-x",
        },
      },
    };
  }
  if (
    method === "POST" &&
    url.startsWith(
      "/v1/organizations/acme/databases/nonprofits-data-x/auth/tokens?",
    )
  ) {
    return { status: 200, json: { jwt: MINTED } };
  }
  if (method === "POST" && url === "/v1/upload") return { status: 200 };
  if (
    method === "DELETE" &&
    url === "/v1/organizations/acme/databases/nonprofits-data-x"
  ) {
    return { status: 200, json: { database: "nonprofits-data-x" } };
  }
  return { status: 404, json: { error: "not found" } };
};

describe("Turso databases", () => {
  let server: Server;
  let base: string;
  let received: Received[];
  let answer: Answer;

  beforeEach(async () => {
    received = [];
    answer = turso;
    server = createServer(async (req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const request: Received = {
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        contentLength: req.headers["content-length"],
        body: Buffer.concat(chunks),
      };
      received.push(request);
      const { status, json, text } = answer(request);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(text ?? (json === undefined ? "" : JSON.stringify(json)));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function host() {
    return tursoDatabases({
      token: PLATFORM_TOKEN,
      org: "acme",
      group: "us-east",
      endpoints: { api: base, upload: () => `${base}/v1/upload` },
    });
  }

  test("create a database seeded for upload in the group, served at its libsql url", async () => {
    const database = await host().create("nonprofits-data-x");
    expect(database).toStrictEqual({
      name: "nonprofits-data-x",
      url: "libsql://nonprofits-data-x-acme.aws-us-east-1.turso.io",
    });
    const [request] = received;
    expect(request?.authorization).toBe(`Bearer ${PLATFORM_TOKEN}`);
    expect(JSON.parse(String(request?.body))).toStrictEqual({
      name: "nonprofits-data-x",
      group: "us-east",
      seed: { type: "database_upload" },
    });
  });

  test("upload the file with a token minted for that database alone, expiring, and redacted from then on", async () => {
    const platform = host();
    const database = await platform.create("nonprofits-data-x");
    const file = join(work, "upload.db");
    await writeFile(file, "the file's bytes");
    await platform.upload(database, file);

    const [, mint, upload] = received;
    const query = new URL(mint?.url ?? "", base).searchParams;
    expect(mint?.method).toBe("POST");
    expect(mint?.authorization).toBe(`Bearer ${PLATFORM_TOKEN}`);
    expect(query.get("authorization")).toBe("full-access");
    expect(query.get("expiration")).toBe("6h");
    expect(upload?.authorization).toBe(`Bearer ${MINTED}`);
    expect(upload?.contentLength).toBe("16");
    expect(String(upload?.body)).toBe("the file's bytes");
    expect(platform.secrets).toStrictEqual([PLATFORM_TOKEN, MINTED]);
  });

  test("open a database it didn't upload, the one served, with a read-only token minted for it, redacted from then on", async () => {
    const platform = host();
    const data = await platform.open({
      name: "nonprofits-data-x",
      url: "libsql://nonprofits-data-x-acme.aws-us-east-1.turso.io",
    });
    data.close();

    const [mint] = received;
    const query = new URL(mint?.url ?? "", base).searchParams;
    expect(mint?.method).toBe("POST");
    expect(mint?.authorization).toBe(`Bearer ${PLATFORM_TOKEN}`);
    expect(query.get("authorization")).toBe("read-only");
    expect(query.get("expiration")).toBe("6h");
    expect(platform.secrets).toStrictEqual([PLATFORM_TOKEN, MINTED]);
  });

  test("open a database it uploaded with the upload's token, minting no other", async () => {
    const platform = host();
    const database = await platform.create("nonprofits-data-x");
    const file = join(work, "upload.db");
    await writeFile(file, "the file's bytes");
    await platform.upload(database, file);
    (await platform.open(database)).close();

    expect(received.filter((r) => r.url.includes("/auth/tokens"))).toHaveLength(
      1,
    );
  });

  test("fail a create Turso refuses with its status and error", async () => {
    answer = () => ({
      status: 409,
      json: { error: "database with name nonprofits-data-x already exists" },
    });
    await expect(host().create("nonprofits-data-x")).rejects.toThrow(
      "POST /v1/organizations/acme/databases answered 409: database with name nonprofits-data-x already exists",
    );
    // taken by someone else: never removed
    expect(received.map((r) => r.method)).toStrictEqual(["POST"]);
  });

  test("remove a database whose create may have committed: no answer, or a 5xx", async () => {
    answer = (request) =>
      request.method === "POST"
        ? { status: 503, json: { error: "unavailable" } }
        : turso(request);
    await expect(host().create("nonprofits-data-x")).rejects.toThrow(
      "POST /v1/organizations/acme/databases answered 503: unavailable; nonprofits-data-x removed in case it was made",
    );
    expect(received.map((r) => r.method)).toStrictEqual(["POST", "DELETE"]);

    received = [];
    await expect(
      host().create("nonprofits-data-x", AbortSignal.abort()),
    ).rejects.toThrow(/removed in case it was made/);
    expect(received.map((r) => r.method)).toStrictEqual(["DELETE"]);
  });

  test("name the command that removes a database whose create may have committed, when removing it fails too", async () => {
    answer = () => ({ status: 503, json: { error: "unavailable" } });
    await expect(host().create("nonprofits-data-x")).rejects.toThrow(
      "could not remove nonprofits-data-x, which may have been made (DELETE /v1/organizations/acme/databases/nonprofits-data-x answered 503: unavailable): `turso db destroy nonprofits-data-x --yes` removes it",
    );
  });

  test("fail an upload Turso refuses with its status, never quoting a token", async () => {
    answer = (request) =>
      request.url === "/v1/upload"
        ? { status: 400, json: { error: "invalid database file" } }
        : turso(request);
    const platform = host();
    const database = await platform.create("nonprofits-data-x");
    const file = join(work, "upload.db");
    await writeFile(file, "not a database");
    const failure = await platform.upload(database, file).catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe(
      "POST /v1/upload answered 400: invalid database file",
    );
  });

  test("keep a refusal's text body short and on one line, so what follows it in a message survives the clip", async () => {
    const page = `<html>\n${"<p>Bad Gateway</p>\n".repeat(400)}</html>`;
    answer = (request) =>
      request.url === "/v1/upload"
        ? { status: 502, text: page }
        : turso(request);
    const platform = host();
    const database = await platform.create("nonprofits-data-x");
    const file = join(work, "upload.db");
    await writeFile(file, "bytes");
    const failure = await platform.upload(database, file).catch((e) => e);
    expect(failure.message).toMatch(
      /^POST \/v1\/upload answered 502: <html> <p>Bad Gateway<\/p> .*… \[\d+ characters cut\]$/,
    );
    expect(failure.message.length).toBeLessThan(400);
  });

  test("remove a database with the platform token", async () => {
    await host().remove("nonprofits-data-x");
    expect(received).toMatchObject([
      {
        method: "DELETE",
        url: "/v1/organizations/acme/databases/nonprofits-data-x",
        authorization: `Bearer ${PLATFORM_TOKEN}`,
      },
    ]);
  });

  test("refuse to remove a database not named as a data database, asking Turso nothing", async () => {
    await expect(host().remove("nonprofits-app")).rejects.toThrow(
      "not removing nonprofits-app: only a database named nonprofits-data-… is the import's",
    );
    expect(received).toStrictEqual([]);
  });

  test("count a database already gone as removed, and fail on any other refusal", async () => {
    await host().remove("nonprofits-data-gone");
    answer = () => ({ status: 503, json: { error: "unavailable" } });
    await expect(host().remove("nonprofits-data-x")).rejects.toThrow(
      "DELETE /v1/organizations/acme/databases/nonprofits-data-x answered 503: unavailable",
    );
  });
});

describe("the host for an app database", () => {
  test.each([
    ["a local file", "file:/repo/.turso/app.db"],
    ["turso dev", "http://127.0.0.1:8080"],
  ])("is local files for %s", async (_, url) => {
    const host = databaseHostFor({ TURSO_APP_DB_URL: url }, work);
    const database = await host.create("nonprofits-data-x");
    expect(database.url).toBe(
      pathToFileURL(join(work, "nonprofits-data-x.db")).href,
    );
    expect(host.secrets).toStrictEqual([]);
  });

  test("is Turso's Platform API for a Turso Cloud one, its token a secret", () => {
    const host = databaseHostFor(
      {
        TURSO_APP_DB_URL: "libsql://nonprofits-app-acme.aws-us-east-1.turso.io",
        TURSO_PLATFORM_TOKEN: PLATFORM_TOKEN,
        TURSO_ORG: "acme",
        TURSO_GROUP: "us-east",
      },
      work,
    );
    expect(host.secrets).toStrictEqual([PLATFORM_TOKEN]);
    expect(host.removeCommand("nonprofits-data-x")).toBe(
      "turso db destroy nonprofits-data-x --yes",
    );
  });

  test("names each setting a Turso Cloud one is missing", () => {
    expect(() =>
      databaseHostFor(
        {
          TURSO_APP_DB_URL:
            "libsql://nonprofits-app-acme.aws-us-east-1.turso.io",
          TURSO_ORG: "acme",
        },
        work,
      ),
    ).toThrow("TURSO_PLATFORM_TOKEN, TURSO_GROUP not set");
  });
});
