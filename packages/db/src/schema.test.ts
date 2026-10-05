import { type Client, createClient } from "@libsql/client";
import { afterEach, describe, expect, test } from "vitest";
import { COLUMNS, createDataDatabase } from "./index.ts";

const open: Client[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

/** A new in-memory data database, its schema built, with `rows` run on it. */
async function dataDatabase(rows = ""): Promise<Client> {
  const db = createClient({ url: ":memory:" });
  open.push(db);
  await createDataDatabase(db);
  await db.executeMultiple(rows);
  return db;
}

/** What running `sql` did: "written", or the error it raised. */
async function outcome(db: Client, sql: string): Promise<string> {
  try {
    await db.executeMultiple(sql);
    return "written";
  } catch (error) {
    return (error as Error).message;
  }
}

describe("COLUMNS", () => {
  test("lists every column of every loaded table a data database builds, in order", async () => {
    const db = await dataDatabase();
    for (const [table, columns] of Object.entries(COLUMNS)) {
      const rs = await db.execute({
        sql: "SELECT name FROM pragma_table_info(?)",
        args: [table],
      });
      expect(
        rs.rows.map((c) => c.name),
        table,
      ).toEqual(columns);
    }
  });
});

describe("date columns", () => {
  /** A data database with one org whose dates are each `null`. */
  function withOrg(): Promise<Client> {
    return dataDatabase(`
      INSERT INTO import_runs VALUES (1, 'bmf', 'https://example.invalid/bmf', '2026-09-07T04:11:46.000Z', '2026-10-03T08:54:47.273Z', 1);
      INSERT INTO orgs (ein) VALUES ('530196605');
    `);
  }

  // each value in the shape the import writes, as read from a full local build
  const ACCEPTED = [
    "UPDATE orgs SET ruling_date = '1946-06'",
    "UPDATE orgs SET revocation_date = '2010-05-15', reinstatement_date = '2026-08-15'",
    "INSERT INTO data_meta VALUES (1, 'build-1', '2026-10-03T09:00:33Z')",
  ];

  const REFUSED = [
    ["ruling_date", "UPDATE orgs SET ruling_date = '194606'"],
    ["ruling_date", "UPDATE orgs SET ruling_date = '1946-06-01'"],
    ["revocation_date", "UPDATE orgs SET revocation_date = '05/15/2010'"],
    ["revocation_date", "UPDATE orgs SET revocation_date = '2010-05'"],
    ["revocation_date", "UPDATE orgs SET revocation_date = '2010-02-30'"],
    ["ruling_date", "UPDATE orgs SET ruling_date = '1946-13'"],
    [
      "reinstatement_date",
      "UPDATE orgs SET revocation_date = '2010-05-15', reinstatement_date = '2026-08-15T00:00:00Z'",
    ],
    ["built_at", "INSERT INTO data_meta VALUES (1, 'build-1', '2026-10-03')"],
    [
      "built_at",
      "INSERT INTO data_meta VALUES (1, 'build-1', '2026-10-03 09:00:33')",
    ],
    [
      "built_at",
      "INSERT INTO data_meta VALUES (1, 'build-1', '2026-10-03T25:00:00Z')",
    ],
  ] as const;

  test("take the formats the import writes", async () => {
    const db = await withOrg();
    const outcomes = [];
    for (const sql of ACCEPTED) outcomes.push(await outcome(db, sql));

    expect(outcomes).toEqual(ACCEPTED.map(() => "written"));
  });

  test.each(REFUSED)("%s refuses %s", async (column, sql) => {
    expect(await outcome(await withOrg(), sql)).toMatch(
      new RegExp(`CHECK constraint failed: .*${column}`),
    );
  });
});

describe("data table constraints", () => {
  /** A data database with import runs 1 (bmf) and 2 (efile_xml), and one org with a filing and a program. */
  function loaded(): Promise<Client> {
    return dataDatabase(`
      INSERT INTO import_runs VALUES (1, 'bmf', 'https://example.invalid/bmf', '2026-09-08T12:00:00.000Z', '2026-09-10T03:00:00.000Z', 1);
      INSERT INTO import_runs VALUES (2, 'efile_xml', 'https://example.invalid/x.zip', '2026-09-04T12:00:00.000Z', '2026-09-10T03:10:00.000Z', 1);
      INSERT INTO orgs (ein, name, name_run_id, street, city, state, zip, address_run_id, bmf_run_id, subsection)
        VALUES ('530196605', 'AMERICAN NATIONAL RED CROSS', 1, '431 18TH ST NW', 'WASHINGTON', 'DC', '20006-5310', 1, 1, '03');
      INSERT INTO filings (ein, object_id, form_type, tax_period, tax_year, run_id)
        VALUES ('530196605', '202511319349301234', '990', '2025-06', 2024, 2);
      INSERT INTO programs (ein, object_id, rank) VALUES ('530196605', '202511319349301234', 1);
    `);
  }

  async function count(db: Client, table: string): Promise<number> {
    const rs = await db.execute(`SELECT count(*) AS n FROM ${table}`);
    return Number(rs.rows[0]?.n);
  }

  // each accepted row sits one step inside a refused one below it
  const ACCEPTED = [
    ["an EIN of 9 digits", "INSERT INTO orgs (ein) VALUES ('123456789')"],
    [
      "an EIN with leading zeros",
      "INSERT INTO orgs (ein) VALUES ('001234567')",
    ],
    [
      "a name with the run that gave it",
      "INSERT INTO orgs (ein, name, name_run_id) VALUES ('123456789', 'X', 1)",
    ],
    [
      "an address with the run that gave it",
      "INSERT INTO orgs (ein, city, address_run_id) VALUES ('123456789', 'BOISE', 1)",
    ],
    [
      "BMF facts with the BMF run",
      "INSERT INTO orgs (ein, subsection, bmf_run_id) VALUES ('123456789', '03', 1)",
    ],
    [
      "a reinstatement after a revocation",
      "INSERT INTO orgs (ein, revocation_date, reinstatement_date) VALUES ('123456789', '2010-05-15', '2026-08-15')",
    ],
    [
      "a revocation with no reinstatement",
      "INSERT INTO orgs (ein, revocation_date) VALUES ('123456789', '2010-05-15')",
    ],
    [
      "an e-Postcard website for a 990-N filer",
      "INSERT INTO orgs (ein, files_990n, epostcard_website) VALUES ('123456789', 1, 'example.org')",
    ],
    [
      "a 990-EZ and a 990-PF for two orgs",
      "INSERT INTO orgs (ein) VALUES ('123456789'), ('223456789'); INSERT INTO filings (ein, object_id, form_type, tax_period, tax_year, run_id) VALUES ('123456789', 'ez', '990-EZ', '2025-06', 2024, 2), ('223456789', 'pf', '990-PF', '2025-06', 2024, 2)",
    ],
    [
      "a program of rank 3",
      "INSERT INTO programs (ein, object_id, rank) VALUES ('530196605', '202511319349301234', 3)",
    ],
    [
      "a source the importer reads",
      "INSERT INTO import_runs VALUES (3, 'pub78', 'https://example.invalid/p', '2026-09-01T12:00:00.000Z', '2026-09-10T03:05:00.000Z', 0)",
    ],
  ] as const;

  const REFUSED = [
    // [what it breaks, the statement, the failure SQLite names]
    [
      "an EIN of 8 digits",
      "INSERT INTO orgs (ein) VALUES ('12345678')",
      /CHECK constraint failed: length\(ein\) = 9/,
    ],
    [
      "an EIN of 10 digits",
      "INSERT INTO orgs (ein) VALUES ('1234567890')",
      /CHECK constraint failed: length\(ein\) = 9/,
    ],
    [
      "an EIN with a letter",
      "INSERT INTO orgs (ein) VALUES ('12345678A')",
      /CHECK constraint failed: length\(ein\) = 9/,
    ],
    [
      "an EIN written with its dash",
      "INSERT INTO orgs (ein) VALUES ('12-3456789')",
      /CHECK constraint failed: length\(ein\) = 9/,
    ],
    [
      "a name with no run",
      "INSERT INTO orgs (ein, name) VALUES ('123456789', 'X')",
      /CHECK constraint failed: \(name IS NULL\) = \(name_run_id IS NULL\)/,
    ],
    [
      "a name run with no name",
      "INSERT INTO orgs (ein, name_run_id) VALUES ('123456789', 1)",
      /CHECK constraint failed: \(name IS NULL\) = \(name_run_id IS NULL\)/,
    ],
    [
      "an address with no run",
      "INSERT INTO orgs (ein, city) VALUES ('123456789', 'BOISE')",
      /CHECK constraint failed: address_run_id IS NOT NULL/,
    ],
    [
      "BMF facts with no BMF run",
      "INSERT INTO orgs (ein, subsection) VALUES ('123456789', '03')",
      /CHECK constraint failed: \(subsection IS NULL\) = \(bmf_run_id IS NULL\)/,
    ],
    [
      "a BMF run with no BMF facts",
      "INSERT INTO orgs (ein, bmf_run_id) VALUES ('123456789', 1)",
      /CHECK constraint failed: \(subsection IS NULL\) = \(bmf_run_id IS NULL\)/,
    ],
    [
      "a reinstatement with no revocation",
      "INSERT INTO orgs (ein, reinstatement_date) VALUES ('123456789', '2026-08-15')",
      /CHECK constraint failed: reinstatement_date IS NULL OR revocation_date IS NOT NULL/,
    ],
    [
      "an e-Postcard website for an org that files no 990-N",
      "INSERT INTO orgs (ein, epostcard_website) VALUES ('123456789', 'example.org')",
      /CHECK constraint failed: epostcard_website IS NULL OR files_990n = 1/,
    ],
    [
      "a Pub 78 flag of 2",
      "INSERT INTO orgs (ein, in_pub78) VALUES ('123456789', 2)",
      /CHECK constraint failed: in_pub78 IN \(0, 1\)/,
    ],
    [
      "a 990-N flag of 2",
      "INSERT INTO orgs (ein, files_990n) VALUES ('123456789', 2)",
      /CHECK constraint failed: files_990n IN \(0, 1\)/,
    ],
    [
      "a name run that isn't an import run",
      "INSERT INTO orgs (ein, name, name_run_id) VALUES ('123456789', 'X', 99)",
      /FOREIGN KEY constraint failed/,
    ],
    [
      "a filing form type outside 990, 990-EZ and 990-PF",
      "UPDATE filings SET form_type = '990-T'",
      /CHECK constraint failed: form_type IN/,
    ],
    [
      "a Schedule O flag of 2",
      "UPDATE filings SET mission_on_schedule_o = 2",
      /CHECK constraint failed: mission_on_schedule_o IN \(0, 1\)/,
    ],
    [
      "a filing for an org that isn't stored",
      "INSERT INTO filings (ein, object_id, form_type, tax_period, tax_year, run_id) VALUES ('999999999', 'x', '990', '2025-06', 2024, 2)",
      /FOREIGN KEY constraint failed/,
    ],
    [
      "a filing from an import run that isn't stored",
      "UPDATE filings SET run_id = 99",
      /FOREIGN KEY constraint failed/,
    ],
    [
      "a program of rank 0",
      "INSERT INTO programs (ein, object_id, rank) VALUES ('530196605', '202511319349301234', 0)",
      /CHECK constraint failed: rank BETWEEN 1 AND 3/,
    ],
    [
      "a program of rank 4",
      "INSERT INTO programs (ein, object_id, rank) VALUES ('530196605', '202511319349301234', 4)",
      /CHECK constraint failed: rank BETWEEN 1 AND 3/,
    ],
    [
      "a program of a return the org didn't file",
      "INSERT INTO programs (ein, object_id, rank) VALUES ('530196605', 'other-return', 1)",
      /FOREIGN KEY constraint failed/,
    ],
    [
      "a program rank twice for one return",
      "INSERT INTO programs (ein, object_id, rank) VALUES ('530196605', '202511319349301234', 1)",
      /UNIQUE constraint failed: programs\.ein, programs\.object_id, programs\.rank/,
    ],
    [
      "a source the importer doesn't read",
      "INSERT INTO import_runs VALUES (3, 'guidestar', 'https://example.invalid/g', '2026-09-01T12:00:00.000Z', '2026-09-10T03:05:00.000Z', 0)",
      /CHECK constraint failed: source IN/,
    ],
    [
      "a negative row count",
      "INSERT INTO import_runs VALUES (3, 'bmf', 'https://example.invalid/b', '2026-09-01T12:00:00.000Z', '2026-09-10T03:05:00.000Z', -1)",
      /CHECK constraint failed: row_count >= 0/,
    ],
  ] as const;

  test.each(ACCEPTED)("takes %s", async (_, sql) => {
    expect(await outcome(await loaded(), sql)).toBe("written");
  });

  test.each(REFUSED)("refuses %s", async (_, sql, failure) => {
    expect(await outcome(await loaded(), sql)).toMatch(failure);
  });

  test("deleting an org takes its filing and that filing's programs with it", async () => {
    const db = await loaded();

    await db.execute("DELETE FROM orgs WHERE ein = '530196605'");

    expect([
      await count(db, "filings"),
      await count(db, "programs"),
    ]).toStrictEqual([0, 0]);
    expect(await count(db, "import_runs")).toBe(2);
  });

  test("deleting a filing takes its programs and leaves its org", async () => {
    const db = await loaded();

    await db.execute("DELETE FROM filings WHERE ein = '530196605'");

    expect([
      await count(db, "programs"),
      await count(db, "orgs"),
    ]).toStrictEqual([0, 1]);
  });

  test("replacing a filing's return while its programs remain is refused", async () => {
    const db = await loaded();

    expect(
      await outcome(
        db,
        "UPDATE filings SET object_id = 'newer' WHERE ein = '530196605'",
      ),
    ).toMatch(/FOREIGN KEY constraint failed/);
  });
});
