import { switchServedDatabase } from "@nonprofits/db";
import {
  appDbFixture,
  dataDbFixture,
  type LocalDb,
} from "@nonprofits/db/fixture";
import { afterEach, expect, test } from "vitest";
import { type DevDatabases, devDatabases } from "./dev-databases.ts";

const opened: (LocalDb | DevDatabases)[] = [];

afterEach(async () => {
  for (const db of opened.splice(0).reverse()) await db.dispose();
});

test("serves the database the pointer in TURSO_APP_DB_URL names", async () => {
  const app = await appDbFixture();
  const data = await dataDbFixture("2026-10-05T05:42:16Z");
  opened.push(app, data);
  await switchServedDatabase(app.client, {
    expected: null,
    to: { name: "nonprofits-data-20261005T054216Z", url: data.url },
    buildId: "2026-10-05T05:42:16Z",
  });

  const dev = await devDatabases({ TURSO_APP_DB_URL: app.url });
  opened.push(dev);

  expect(dev.serving).toBe("nonprofits-data-20261005T054216Z");
});

test("refuses an app database that serves nothing yet", async () => {
  const app = await appDbFixture();
  opened.push(app);

  await expect(devDatabases({ TURSO_APP_DB_URL: app.url })).rejects.toThrow(
    /serves no data database: run `irs refresh`/,
  );
});

test("serves fresh fixture databases without TURSO_APP_DB_URL", async () => {
  const dev = await devDatabases({});
  opened.push(dev);

  expect(dev.serving).toBe("nonprofits-fixture");
});
