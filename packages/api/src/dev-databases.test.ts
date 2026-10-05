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

/** A migrated app database whose pointer names a data database `irs refresh` would have published. */
async function servingAppDb(): Promise<LocalDb> {
  const app = await appDbFixture();
  const data = await dataDbFixture("2026-10-05T05:42:16Z");
  opened.push(app, data);
  await switchServedDatabase(app.client, {
    expected: null,
    to: { name: "nonprofits-data-20261005t054216z", url: data.url },
    buildId: "2026-10-05T05:42:16Z",
  });
  return app;
}

const NO_LOCAL_APP_DB = new URL("file:///nonexistent/.turso/app.db");

test("serves the database the pointer in TURSO_APP_DB_URL names", async () => {
  const app = await servingAppDb();

  const dev = await devDatabases(
    { TURSO_APP_DB_URL: app.url },
    NO_LOCAL_APP_DB,
  );
  opened.push(dev);

  expect(dev.serving).toBe("nonprofits-data-20261005t054216z");
});

test("refuses a TURSO_APP_DB_URL that serves nothing yet", async () => {
  const app = await appDbFixture();
  opened.push(app);

  await expect(
    devDatabases({ TURSO_APP_DB_URL: app.url }, NO_LOCAL_APP_DB),
  ).rejects.toThrow(/serves no data database: run `irs refresh`/);
});

test("without TURSO_APP_DB_URL, serves the local app database's pointer", async () => {
  const app = await servingAppDb();

  const dev = await devDatabases({}, new URL(app.url));
  opened.push(dev);

  expect(dev.serving).toBe("nonprofits-data-20261005t054216z");
});

test("serves fresh fixture databases when there is no local app database", async () => {
  const dev = await devDatabases({}, NO_LOCAL_APP_DB);
  opened.push(dev);

  expect(dev.serving).toBe("nonprofits-fixture");
});

test("serves fresh fixture databases while the local app database serves nothing", async () => {
  const app = await appDbFixture();
  opened.push(app);

  const dev = await devDatabases({}, new URL(app.url));
  opened.push(dev);

  expect(dev.serving).toBe("nonprofits-fixture");
});
