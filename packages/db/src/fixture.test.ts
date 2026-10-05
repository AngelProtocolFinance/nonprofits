import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { dataDbFixture, type LocalDb } from "./fixture.ts";

let data: LocalDb;

beforeEach(async () => {
  data = await dataDbFixture("20260910T030000Z");
});

afterEach(async () => {
  await data.dispose();
});

describe("dataDbFixture", () => {
  test("builds a file whose Red Cross row reads back with its import_runs sources", async () => {
    const reader = createClient({ url: data.url });
    const rs = await reader.execute({
      sql: `SELECT o.name, n.source AS name_source, a.source AS address_source, b.source AS bmf_source,
  f.source AS filing_source
FROM orgs o
JOIN import_runs n ON n.id = o.name_run_id
JOIN import_runs a ON a.id = o.address_run_id
JOIN import_runs b ON b.id = o.bmf_run_id
JOIN filings ON filings.ein = o.ein
JOIN import_runs f ON f.id = filings.run_id
WHERE o.ein = ?`,
      args: ["530196605"],
    });
    reader.close();

    expect(rs.rows.map((r) => ({ ...r }))).toStrictEqual([
      {
        name: "AMERICAN NATIONAL RED CROSS",
        name_source: "bmf",
        address_source: "bmf",
        bmf_source: "bmf",
        filing_source: "efile_xml",
      },
    ]);
  });
});
