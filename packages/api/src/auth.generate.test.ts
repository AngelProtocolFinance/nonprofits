import { appDbFixture, type LocalDb } from "@nonprofits/db/fixture";
import type { BetterAuthOptions } from "better-auth";
import { afterEach, describe, expect, test } from "vitest";
import { pendingAuthMigration } from "./auth.generate.ts";
import { authOptions } from "./auth.ts";

let appDb: LocalDb;

afterEach(async () => {
  await appDb.dispose();
});

const UP_TO_DATE = { sql: "", schemaProblems: [] };

describe("pendingAuthMigration", () => {
  test("is empty over the app migrations: they hold every table, column and index better-auth expects, and nothing it can't write", async () => {
    appDb = await appDbFixture();

    expect(await pendingAuthMigration(appDb.client)).toStrictEqual(UP_TO_DATE);
  });

  test("a field the migrations lack comes out as an ALTER, with a date as text, that the STRICT table accepts", async () => {
    appDb = await appDbFixture();
    const options = {
      ...authOptions,
      user: {
        additionalFields: { lastSeenAt: { type: "date", required: false } },
      },
    } as const;

    const { sql } = await pendingAuthMigration(appDb.client, options);

    expect(sql).toBe('alter table "user" add column "lastSeenAt" text;\n');
    await appDb.client.executeMultiple(sql);
    expect(await pendingAuthMigration(appDb.client, options)).toStrictEqual(
      UP_TO_DATE,
    );
  });

  test("a table the migrations lack comes out STRICT, its dates as text and big numbers as integer, and creates", async () => {
    appDb = await appDbFixture();
    const options: BetterAuthOptions = {
      ...authOptions,
      plugins: [
        ...authOptions.plugins,
        {
          id: "widgets",
          schema: {
            widget: {
              fields: {
                seenAt: { type: "date", required: true },
                total: { type: "number", bigint: true, required: true },
              },
            },
          },
        },
      ],
    };

    const { sql } = await pendingAuthMigration(appDb.client, options);

    expect(sql).toBe(
      'create table "widget" ("id" text not null primary key, "seenAt" text not null, "total" integer not null) strict;\n',
    );
    await appDb.client.executeMultiple(sql);
    const strict = await appDb.client.execute(
      "SELECT strict FROM pragma_table_list WHERE name = 'widget'",
    );
    expect(strict.rows[0]?.strict).toBe(1);
    expect(await pendingAuthMigration(appDb.client, options)).toStrictEqual(
      UP_TO_DATE,
    );
  });

  test("names a required column better-auth never writes, which would fail every insert", async () => {
    appDb = await appDbFixture();
    const options = {
      ...authOptions,
      user: { fields: { name: "displayName" } },
    } as const;

    const { schemaProblems } = await pendingAuthMigration(
      appDb.client,
      options,
    );

    expect(schemaProblems).toHaveLength(1);
    expect(schemaProblems[0]).toMatch(
      /^Column "name" on table "user" is required but Better Auth never writes it/,
    );
  });
});
