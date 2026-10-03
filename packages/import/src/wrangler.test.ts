import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { stopWrangler, wrangler } from "./wrangler.ts";

let persistTo: string;

const select = () => [
  "d1",
  "execute",
  "APP_DB",
  "--local",
  "--persist-to",
  persistTo,
  "--command",
  "SELECT 1",
];

beforeAll(async () => {
  persistTo = await mkdtemp(join(tmpdir(), "wrangler-"));
});

afterAll(async () => {
  if (persistTo) await rm(persistTo, { recursive: true, force: true });
});

describe("wrangler", { timeout: 60_000 }, () => {
  test("runs a command to its output", async () => {
    expect(await wrangler(select(), 60_000)).toContain('"1": 1');
  });

  test("kills a command that outlives its timeout", async () => {
    await expect(wrangler(select(), 200)).rejects.toThrow(
      "wrangler d1 execute timed out after 200 ms",
    );
  });

  // last: a stop leaves the module refusing every call but its cleanup's
  test("stopWrangler kills the running command, refuses the run's next one, then runs its cleanup alone", async () => {
    const running = wrangler(select(), 60_000);
    const stopped = expect(running).rejects.toThrow(
      "wrangler d1 execute stopped",
    );

    const cleaned = await stopWrangler(() => wrangler(select(), 60_000));

    await stopped;
    expect(cleaned).toContain('"1": 1');
    await expect(wrangler(select(), 60_000)).rejects.toThrow(
      "wrangler d1 execute stopped",
    );
  });
});
