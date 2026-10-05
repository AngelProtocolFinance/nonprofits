import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { switchServedDatabase } from "@nonprofits/db";
import {
  appDbFixture,
  dataDbFixture,
  type LocalDb,
} from "@nonprofits/db/fixture";
import { afterEach, expect, test } from "vitest";

const API_ROOT = new URL("../", import.meta.url);

async function freePort(): Promise<number> {
  const probe = createServer().listen(0);
  await once(probe, "listening");
  const address = probe.address();
  probe.close();
  if (address === null || typeof address === "string") {
    throw new Error("no port");
  }
  return address.port;
}

let dev: ChildProcess | undefined;
const databases: LocalDb[] = [];

afterEach(async () => {
  if (dev?.exitCode === null) {
    dev.kill("SIGTERM");
    await once(dev, "exit");
  }
  dev = undefined;
  for (const db of databases.splice(0)) await db.dispose();
});

/** Starts `src/dev.ts` with `args` and `env` on a free port; resolves with its port and the line it logged once listening. */
async function startDev(
  args: string[],
  env: Record<string, string>,
): Promise<{ port: number; started: string }> {
  const port = await freePort();
  dev = spawn(process.execPath, [...args, "src/dev.ts"], {
    cwd: fileURLToPath(API_ROOT),
    env: { PATH: process.env.PATH, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const stdout = dev.stdout;
  if (stdout === null) throw new Error("no stdout");
  const started = await new Promise<string>((resolve, reject) => {
    stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes("api on http://localhost")) resolve(text);
    });
    dev?.once("exit", (code) => reject(new Error(`dev exited ${code}`)));
  });
  return { port, started };
}

test("`pnpm dev` over a copy of .env.example serves lookups", {
  timeout: 30_000,
}, async () => {
  const { port } = await startDev(["--env-file=.env.example"], {});
  const response = await fetch(`http://localhost:${port}/v1/orgs/530196605`);
  expect(response.status).toBe(200);
});

test("`pnpm dev` serves the data database the pointer in TURSO_APP_DB_URL names", {
  timeout: 30_000,
}, async () => {
  const app = await appDbFixture();
  const data = await dataDbFixture("2026-10-05T05:42:16Z");
  databases.push(app, data);
  await switchServedDatabase(app.client, {
    expected: null,
    to: { name: "nonprofits-data-20261005t054216z", url: data.url },
    buildId: "2026-10-05T05:42:16Z",
  });

  const { port, started } = await startDev([], { TURSO_APP_DB_URL: app.url });
  const response = await fetch(`http://localhost:${port}/v1/orgs/530196605`, {
    headers: { "x-real-ip": "198.51.100.7" },
  });

  expect(started).toContain(
    `serving nonprofits-data-20261005t054216z from ${app.url}`,
  );
  expect(response.status).toBe(200);
});
