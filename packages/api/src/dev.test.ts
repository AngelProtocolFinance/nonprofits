import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
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

afterEach(async () => {
  if (dev?.exitCode === null) {
    dev.kill("SIGTERM");
    await once(dev, "exit");
  }
  dev = undefined;
});

test("`pnpm dev` over a copy of .env.example serves lookups", {
  timeout: 30_000,
}, async () => {
  const port = await freePort();
  dev = spawn(process.execPath, ["--env-file=.env.example", "src/dev.ts"], {
    cwd: fileURLToPath(API_ROOT),
    env: { PATH: process.env.PATH, PORT: String(port) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const stdout = dev.stdout;
  if (stdout === null) throw new Error("no stdout");
  await new Promise<void>((resolve, reject) => {
    stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("api on http://localhost")) resolve();
    });
    dev?.once("exit", (code) => reject(new Error(`dev exited ${code}`)));
  });
  const response = await fetch(`http://localhost:${port}/v1/orgs/530196605`);
  expect(response.status).toBe(200);
});
