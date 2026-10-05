import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Client } from "@libsql/client";
import { dataDbClient } from "@nonprofits/db/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "vitest";
import { fileTarget, LOAD_CHUNK_CHARS } from "./target.ts";

let work: string;
let data: Client;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "file-target-"));
});

afterAll(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

beforeEach(async () => {
  data = dataDbClient(
    pathToFileURL(join(work, `${crypto.randomUUID()}.db`)).href,
    {},
  );
  await data.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) STRICT");
});

afterEach(() => {
  data.close();
});

/** Text with every character a statement split could trip on: a quote, `;` and line ends inside the literal. */
function awkward(id: number): string {
  return `${id}: it's; done;\nnext'';\r\nlast — é;`.padEnd(2_000, "x;'\n");
}

/** A load file of `rows` single-row inserts of `awkward` text, then `tail`. */
async function loadFile(
  name: string,
  rows: number,
  tail = "",
): Promise<string> {
  const file = join(work, name);
  const statements: string[] = [];
  for (let id = 1; id <= rows; id++) {
    statements.push(
      `INSERT INTO t (id, v) VALUES (${id}, '${awkward(id).replaceAll("'", "''")}');\n`,
    );
  }
  await writeFile(file, statements.join("") + tail);
  return file;
}

/** Enough rows that the load spans several chunks. */
const ROWS = Math.ceil((2.5 * LOAD_CHUNK_CHARS) / 2_000);

test("applies a load larger than one chunk whole, its literals intact", {
  timeout: 30_000,
}, async () => {
  const file = await loadFile("big.load.sql", ROWS);

  await fileTarget(data).apply(file);

  const rs = await data.execute("SELECT id, v FROM t ORDER BY id");
  expect(rs.rows.length).toBe(ROWS);
  const wrong = rs.rows.filter((row) => row.v !== awkward(Number(row.id)));
  expect(wrong.map((row) => row.id)).toStrictEqual([]);
});

test("a statement failing after the first chunk leaves nothing of the load", {
  timeout: 30_000,
}, async () => {
  const file = await loadFile(
    "failing.load.sql",
    ROWS,
    "INSERT INTO t (id, v) VALUES (1, 'a duplicate id');\n",
  );

  await expect(fileTarget(data).apply(file)).rejects.toThrow(
    "UNIQUE constraint failed: t.id",
  );

  const rs = await data.execute("SELECT count(*) AS n FROM t");
  expect(rs.rows[0]?.n).toBe(0);
});
