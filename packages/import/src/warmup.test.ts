import type { Client, InStatement } from "@libsql/client";
import { FILING_SIZE_INDEX, matchExpression, searchSql } from "@nonprofits/db";
import { dataDbFixture, type LocalDb } from "@nonprofits/db/fixture";
import { afterEach, describe, expect, test } from "vitest";
import { WARMUP_TERMS, warmUploadedDatabase } from "./warmup.ts";

const FILINGS_SIZE_SQL = `SELECT total_revenue FROM filings INDEXED BY ${FILING_SIZE_INDEX} LIMIT 1`;
const ORGS_KEY_SQL =
  "SELECT ein FROM orgs INDEXED BY sqlite_autoindex_orgs_1 LIMIT 1";

const empty = {
  columns: [],
  columnTypes: [],
  rows: [],
  rowsAffected: 0,
};

interface Sent {
  sql: string;
  args: unknown[];
}

function statementOf(statement: InStatement): Sent {
  if (typeof statement === "string") return { sql: statement, args: [] };
  const args = statement.args;
  return {
    sql: statement.sql,
    args: args === undefined ? [] : Array.isArray(args) ? [...args] : [args],
  };
}

function client(execute: (statement: InStatement) => Promise<unknown>): Client {
  return { execute } as Client;
}

describe("warmUploadedDatabase", () => {
  test("runs each common term's search, then the filings size index, then the orgs key", async () => {
    const sent: Sent[] = [];
    const db = client(async (statement) => {
      sent.push(statementOf(statement));
      return empty;
    });

    const report = await warmUploadedDatabase({ db, now: () => 0 });

    expect(sent).toEqual([
      ...WARMUP_TERMS.map((term) => ({
        sql: searchSql(true),
        args: [matchExpression(term.split(" ")), 1],
      })),
      { sql: FILINGS_SIZE_SQL, args: [] },
      { sql: ORGS_KEY_SQL, args: [] },
    ]);
    expect(report.skipped).toBe(0);
    expect(report.warnings).toEqual([]);
    expect(report.queries.every((query) => query.ok)).toBe(true);
  });

  test("stops once the budget is spent and warns, leaving the rest unstarted", async () => {
    let now = 0;
    let calls = 0;
    const db = client(async () => {
      calls += 1;
      if (calls === 2) now = 1_000;
      return empty;
    });

    const report = await warmUploadedDatabase({
      db,
      budgetMs: 1_000,
      now: () => now,
    });

    expect(calls).toBe(2);
    expect(report.skipped).toBe(WARMUP_TERMS.length + 2 - 2);
    expect(report.warnings).toEqual([
      "WARNING: warm-up stopped after 2 of 42 queries: budget 1 s spent",
    ]);
  });

  test("a query that fails is a warning and the later queries still run", async () => {
    let calls = 0;
    const db = client(async () => {
      calls += 1;
      if (calls === 2) throw new Error("disk I/O");
      return empty;
    });

    const report = await warmUploadedDatabase({ db, now: () => 0 });

    expect(calls).toBe(WARMUP_TERMS.length + 2);
    expect(report.queries[1]).toMatchObject({
      label: "church",
      ok: false,
      warning: 'WARNING: warm-up "church" failed after 0.0 s: disk I/O',
    });
    expect(report.queries.filter((query) => !query.ok)).toHaveLength(1);
    expect(report.warnings).toEqual([
      'WARNING: warm-up "church" failed after 0.0 s: disk I/O',
    ]);
    expect(report.skipped).toBe(0);
  });

  test("a query that outlasts its own time is a warning and the next query runs", async () => {
    let calls = 0;
    const db = client(
      () =>
        new Promise((resolve) => {
          calls += 1;
          if (calls === 1) return;
          resolve(empty);
        }),
    );

    const report = await warmUploadedDatabase({
      db,
      queryTimeoutMs: 20,
      now: () => 0,
    });

    expect(calls).toBe(WARMUP_TERMS.length + 2);
    expect(report.queries[0]?.warning).toContain("timed out after 20 ms");
    expect(report.queries[1]?.ok).toBe(true);
  });

  test("an abort rejects and does not start another query", async () => {
    const signal = new AbortController();
    let calls = 0;
    const db = client(
      () =>
        new Promise(() => {
          calls += 1;
          signal.abort(new Error("stopped: SIGTERM"));
        }),
    );

    await expect(
      warmUploadedDatabase({ db, signal: signal.signal, now: () => 0 }),
    ).rejects.toThrow("stopped: SIGTERM");
    expect(calls).toBe(1);
  });

  test("a query failure names its cause's code and message in the warning", async () => {
    const db = client(async () => {
      throw new Error("fetch failed", {
        cause: Object.assign(new Error("Headers Timeout Error"), {
          code: "UND_ERR_HEADERS_TIMEOUT",
        }),
      });
    });

    const report = await warmUploadedDatabase({ db, now: () => 0 });

    expect(report.warnings[0]).toBe(
      'WARNING: warm-up "united way" failed after 0.0 s: fetch failed (UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error)',
    );
  });
});

describe("warmUploadedDatabase on a built database", () => {
  let data: LocalDb | undefined;

  afterEach(async () => {
    await data?.dispose();
    data = undefined;
  });

  test("the search and both index reads prepare", async () => {
    data = await dataDbFixture("20261017T000000Z");

    const report = await warmUploadedDatabase({ db: data.client });

    expect(report.queries).toHaveLength(WARMUP_TERMS.length + 2);
    expect(report.queries.every((query) => query.ok)).toBe(true);
    expect(report.skipped).toBe(0);
    expect(report.warnings).toEqual([]);
  });
});
