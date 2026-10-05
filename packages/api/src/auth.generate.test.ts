import { appDbFixture, type LocalDb } from "@nonprofits/db/fixture";
import { afterEach, describe, expect, test } from "vitest";
import { pendingAuthMigration } from "./auth.generate.ts";
import { authOptions } from "./auth.ts";

let appDb: LocalDb;

afterEach(async () => {
  await appDb.dispose();
});

describe("pendingAuthMigration", () => {
  test("is empty over the app migrations: they hold every table, column and index better-auth expects", async () => {
    appDb = await appDbFixture();

    expect(await pendingAuthMigration(appDb.client)).toBe("");
  });

  test("a field the migrations lack comes out as an ALTER, with a date as text, that the STRICT table accepts", async () => {
    appDb = await appDbFixture();
    const options = {
      ...authOptions,
      user: {
        additionalFields: { lastSeenAt: { type: "date", required: false } },
      },
    } as const;

    const sql = await pendingAuthMigration(appDb.client, options);

    expect(sql).toBe('alter table "user" add column "lastSeenAt" text;\n');
    await appDb.client.executeMultiple(sql);
    expect(await pendingAuthMigration(appDb.client, options)).toBe("");
  });
});
