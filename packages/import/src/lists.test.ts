import { randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { importBmf } from "./bmf.ts";
import { importList, type ListName } from "./lists.ts";
import type { DownloadRetry } from "./load.ts";
import {
  loadTarget,
  query,
  quickRetry,
  type Route,
  resetDataDb,
  serve,
} from "./test-support.ts";

const BMF_FIXTURES = new URL("../fixtures/bmf/", import.meta.url);
const BMF_FILES = ["eo1.csv", "eo2.csv", "eo3.csv", "eo4.csv"];
const LIST_FIXTURES = new URL("../fixtures/lists/", import.meta.url);
const RELEASED = "Thu, 10 Sep 2026 09:18:37 GMT";
/** Rows in each list fixture. */
const FIXTURE_ROWS = { pub78: 122, revocation: 31, epostcard: 95 };
/** EINs each list's second run drops: its first, one inside, and its last. */
const UNLISTED = {
  pub78: ["000587764", "530196605", "999999010"],
  revocation: ["010011694", "010281533", "237069967"],
  epostcard: ["000100514", "010494386", "237063049"],
};

/** The list's text file, zipped the way the IRS ships it: one deflated entry. */
function zipped(list: ListName, text: string): Uint8Array {
  return zipSync({
    [`data-download-${list}.txt`]: [
      new TextEncoder().encode(text),
      { level: 6 },
    ],
  });
}

function fixtureText(list: ListName): Promise<string> {
  return readFile(new URL(`data-download-${list}.txt`, LIST_FIXTURES), "utf8");
}

let server: Server;
let base: string;
let work: string;

beforeAll(async () => {
  const routes = new Map<string, Route>();
  for (const name of BMF_FILES) {
    routes.set(`/${name}`, await readFile(new URL(name, BMF_FIXTURES), "utf8"));
  }
  for (const list of ["pub78", "revocation", "epostcard"] as const) {
    routes.set(`/${list}.zip`, zipped(list, await fixtureText(list)));
  }
  const revocation = await fixtureText("revocation");
  const [older = "", newer = ""] = revocation
    .split("\r\n")
    .filter((line) => line.startsWith("010043788|"));
  routes.set(
    "/swapped/revocation.zip",
    zipped(
      "revocation",
      revocation.replace(`${older}\r\n${newer}`, `${newer}\r\n${older}`),
    ),
  );
  for (const list of ["pub78", "revocation", "epostcard"] as const) {
    const lastColumnDropped = (await fixtureText(list)).replace(
      /\|[^|\r\n]*(?=\r\n)/g,
      "",
    );
    routes.set(`/dropped/${list}.zip`, zipped(list, lastColumnDropped));
  }
  const pub78 = zipped("pub78", await fixtureText("pub78"));
  let stallOnce = true;
  routes.set("/stall-once/pub78.zip", (res) => {
    res.writeHead(200, { "last-modified": RELEASED });
    if (stallOnce) res.write(pub78.subarray(0, pub78.length / 2));
    else res.end(pub78);
    stallOnce = false;
  });
  routes.set("/cut/pub78.zip", (res) => {
    res.writeHead(200, { "last-modified": RELEASED });
    res.end(pub78.subarray(0, pub78.length / 2));
  });
  routes.set(
    "/page/pub78.zip",
    "<html><body>Service unavailable</body></html>",
  );
  for (const list of ["pub78", "revocation", "epostcard"] as const) {
    const kept = (await fixtureText(list))
      .split("\r\n")
      .filter(
        (line) => !UNLISTED[list].some((ein) => line.startsWith(`${ein}|`)),
      )
      .join("\r\n");
    routes.set(`/unlisted/${list}.zip`, zipped(list, kept));
  }
  const [first = "", second = ""] = (await fixtureText("pub78"))
    .split("\r\n")
    .filter(Boolean);
  routes.set(
    "/unsorted/pub78.zip",
    zipped(
      "pub78",
      (await fixtureText("pub78")).replace(
        `${first}\r\n${second}`,
        `${second}\r\n${first}`,
      ),
    ),
  );
  routes.set(
    "/older/revocation.zip",
    zipped("revocation", revocation.replace(`\r\n${newer}`, "")),
  );
  routes.set(
    "/short-ein/pub78.zip",
    zipped(
      "pub78",
      (await fixtureText("pub78")).replace("\r\n000635913|", "\r\n00635913|"),
    ),
  );
  const trailing = zipSync({
    "data-download-pub78.txt": [
      new TextEncoder().encode(await fixtureText("pub78")),
      { level: 6 },
    ],
    "trailing.bin": [randomBytes(64 * 1024), { level: 0 }],
  });
  routes.set("/trailing/pub78.zip", (res) => {
    res.writeHead(200, { "last-modified": RELEASED });
    // stalls inside the second entry and never ends
    res.write(trailing.subarray(0, trailing.length - 32 * 1024));
  });
  ({ server, base } = await serve(routes, RELEASED));
  work = await mkdtemp(join(tmpdir(), "list-import-"));
}, 60_000);

afterAll(async () => {
  server?.close();
  if (work) await rm(work, { recursive: true, force: true });
});

/** A fresh local data DB under `work`, reset. */
async function freshD1(name: string): Promise<string> {
  const persistTo = join(work, name);
  await resetDataDb(persistTo);
  return persistTo;
}

function loadBmf(persistTo: string) {
  return importBmf({
    urls: BMF_FILES.map((name) => `${base}/${name}`),
    minOrgs: 1,
    out: join(work, "bmf.load.sql"),
    target: loadTarget(persistTo),
  });
}

function loadList(
  persistTo: string,
  list: ListName,
  options: {
    path?: string;
    minRows?: number;
    maxStatementBytes?: number;
    retry?: DownloadRetry;
  } = {},
) {
  return importList(list, {
    url: `${base}${options.path ?? `/${list}.zip`}`,
    minRows: options.minRows ?? 1,
    out: join(work, `${list}.load.sql`),
    target: loadTarget(persistTo),
    retry: options.retry ?? quickRetry(),
    ...(options.maxStatementBytes === undefined
      ? {}
      : { maxStatementBytes: options.maxStatementBytes }),
  });
}

describe("after the BMF and all three lists are imported", {
  timeout: 60_000,
}, () => {
  let d1: string;

  beforeAll(async () => {
    d1 = await freshD1("all");
    await loadBmf(d1);
    await loadList(d1, "pub78");
    await loadList(d1, "revocation");
    await loadList(d1, "epostcard");
  }, 120_000);

  test("the Red Cross is listed in Pub 78, as of the Pub 78 file", async () => {
    const rows = await query(
      d1,
      `SELECT o.in_pub78, r.source, r.file_url, r.released_at
      FROM orgs o, import_runs r
      WHERE o.ein = '530196605' AND r.id = (SELECT max(id) FROM import_runs WHERE source = 'pub78')`,
    );
    expect(rows).toStrictEqual([
      {
        in_pub78: 1,
        source: "pub78",
        file_url: `${base}/pub78.zip`,
        released_at: "2026-09-10T09:18:37.000Z",
      },
    ]);
  });

  test("an EIN only Pub 78 lists gets its name and city from Pub 78", async () => {
    const rows = await query(d1, orgWithSources("999999010"));
    expect(rows).toStrictEqual([
      {
        name: "Association of Fundraising Professionals",
        name_source: "pub78",
        street: null,
        city: "Arlington",
        state: "VA",
        zip: null,
        address_source: "pub78",
        bmf_run_id: null,
        in_pub78: 1,
      },
    ]);
  });

  test("a revoked EIN absent from the BMF gets its revocation and org facts from the revocation list", async () => {
    const rows = await query(
      d1,
      `SELECT o.name, o.street, o.city, o.state, o.zip, o.revocation_date, o.reinstatement_date,
        n.file_url AS name_file, a.file_url AS address_file, o.bmf_run_id,
        (SELECT file_url FROM import_runs WHERE id = (SELECT max(id) FROM import_runs WHERE source = 'revocation')) AS revocation_file
      FROM orgs o
      JOIN import_runs n ON n.id = o.name_run_id
      JOIN import_runs a ON a.id = o.address_run_id
      WHERE o.ein = '010281533'`,
    );
    expect(rows).toStrictEqual([
      {
        name: "GREEN VALLEY ASSOCIATION",
        street: "PO BOX 127",
        city: "ISLAND FALLS",
        state: "ME",
        zip: "04747-0127",
        revocation_date: "2025-11-15",
        reinstatement_date: null,
        name_file: `${base}/revocation.zip`,
        address_file: `${base}/revocation.zip`,
        bmf_run_id: null,
        revocation_file: `${base}/revocation.zip`,
      },
    ]);
  });

  test("an EIN listed twice keeps its latest revocation and that one's reinstatement", async () => {
    const rows = await query(
      d1,
      "SELECT revocation_date, reinstatement_date FROM orgs WHERE ein = '010043788'",
    );
    expect(rows).toStrictEqual([
      { revocation_date: "2019-03-15", reinstatement_date: "2020-05-15" },
    ]);
  });

  test("a 990-N filer is flagged with its e-Postcard website, as of the e-Postcard file", async () => {
    const rows = await query(
      d1,
      `SELECT o.files_990n, o.epostcard_website, r.source, r.file_url
      FROM orgs o, import_runs r
      WHERE o.ein = '010494386' AND r.id = (SELECT max(id) FROM import_runs WHERE source = 'epostcard')`,
    );
    expect(rows).toStrictEqual([
      {
        files_990n: 1,
        epostcard_website: "www.maritimehistory.org",
        source: "epostcard",
        file_url: `${base}/epostcard.zip`,
      },
    ]);
  });

  test("an e-Postcard website that isn't a web address is stored as null, the org still flagged", async () => {
    const rows = await query(
      d1,
      `SELECT ein, files_990n, epostcard_website FROM orgs
      WHERE ein IN ('010019709', '010024155', '010265029', '010414383', '010418163', '232592298')
      ORDER BY ein`,
    );
    expect(rows).toStrictEqual([
      { ein: "010019709", files_990n: 1, epostcard_website: null },
      { ein: "010024155", files_990n: 1, epostcard_website: null },
      {
        ein: "010265029",
        files_990n: 1,
        epostcard_website: "https://www.cossar.org/chapters",
      },
      { ein: "010414383", files_990n: 1, epostcard_website: "ducks.org" },
      { ein: "010418163", files_990n: 1, epostcard_website: null },
      { ein: "232592298", files_990n: 1, epostcard_website: null },
    ]);
  });

  test("an EIN only the e-Postcard lists gets a row with the 990-N flag and nothing else", async () => {
    const rows = await query(
      d1,
      "SELECT name, name_run_id, address_run_id, bmf_run_id, in_pub78, revocation_date, files_990n FROM orgs WHERE ein = '000100514'",
    );
    expect(rows).toStrictEqual([
      {
        name: null,
        name_run_id: null,
        address_run_id: null,
        bmf_run_id: null,
        in_pub78: 0,
        revocation_date: null,
        files_990n: 1,
      },
    ]);
  });

  test("each list's run records its file, its release and its row count", async () => {
    const rows = await query(
      d1,
      "SELECT source, file_url, released_at, row_count FROM import_runs WHERE source <> 'bmf' ORDER BY id",
    );
    expect(rows).toStrictEqual(
      (["pub78", "revocation", "epostcard"] as const).map((list) => ({
        source: list,
        file_url: `${base}/${list}.zip`,
        released_at: "2026-09-10T09:18:37.000Z",
        row_count: FIXTURE_ROWS[list],
      })),
    );
  });

  test.each([
    ["pub78", "Pub 78"],
    ["revocation", "Revocation list"],
    ["epostcard", "e-Postcard"],
  ] as const)(
    "a %s file short of its floor aborts, loading nothing",
    async (list, label) => {
      const before = await counts(d1);
      const rows = FIXTURE_ROWS[list];
      await expect(loadList(d1, list, { minRows: rows + 1 })).rejects.toThrow(
        `${label} import aborted: ${rows} rows is below the floor of ${rows + 1}; nothing was loaded`,
      );
      expect(await counts(d1)).toStrictEqual(before);
    },
  );

  test.each([
    ["a zip that ends mid-file", "/cut/pub78.zip", ""],
    [
      "a page that isn't a zip",
      "/page/pub78.zip",
      "zip archive holds no complete file",
    ],
  ])(
    "%s aborts, loading nothing and leaving no load file",
    async (_, path, detail) => {
      const before = await counts(d1);
      await expect(loadList(d1, "pub78", { path })).rejects.toThrow(
        `Pub 78 download failed: ${base}${path}: ${detail}`,
      );
      await expect(access(join(work, "pub78.load.sql"))).rejects.toThrow(
        "ENOENT",
      );
      expect(await counts(d1)).toStrictEqual(before);
    },
  );

  test("a row whose EIN isn't 9 digits aborts, loading nothing", async () => {
    const before = await counts(d1);
    await expect(
      loadList(d1, "pub78", { path: "/short-ein/pub78.zip" }),
    ).rejects.toThrow(
      `Pub 78 layout changed in ${base}/short-ein/pub78.zip: row 2: field 1 is "00635913", expected a 9-digit EIN`,
    );
    expect(await counts(d1)).toStrictEqual(before);
  });

  test("a list out of EIN order aborts, loading nothing", async () => {
    const before = await counts(d1);
    await expect(
      loadList(d1, "pub78", { path: "/unsorted/pub78.zip" }),
    ).rejects.toThrow(
      `Pub 78 layout changed in ${base}/unsorted/pub78.zip: row 2: EIN 000587764 follows 000635913, expected EIN order`,
    );
    expect(await counts(d1)).toStrictEqual(before);
  });

  test.each([
    ["pub78", "Pub 78", 5, 6],
    ["revocation", "Revocation list", 11, 12],
    ["epostcard", "e-Postcard", 25, 26],
  ] as const)(
    "a %s file missing a column aborts, loading nothing",
    async (list, label, found, expected) => {
      const before = await counts(d1);
      await expect(
        loadList(d1, list, { path: `/dropped/${list}.zip` }),
      ).rejects.toThrow(
        `${label} layout changed in ${base}/dropped/${list}.zip: row 1 has ${found} fields, expected ${expected}`,
      );
      await expect(access(join(work, `${list}.load.sql`))).rejects.toThrow(
        "ENOENT",
      );
      expect(await counts(d1)).toStrictEqual(before);
    },
  );
});

describe("a list's next run", { timeout: 60_000 }, () => {
  /** What each list says about an org it lists. */
  const LISTED = {
    pub78: "in_pub78 = 1",
    revocation: "revocation_date IS NOT NULL",
    epostcard: "files_990n = 1",
  };
  let d1: string;

  beforeAll(async () => {
    d1 = await freshD1("relisted");
    for (const list of ["pub78", "revocation", "epostcard"] as const) {
      await loadList(d1, list);
      await loadList(d1, list, {
        path: `/unlisted/${list}.zip`,
        maxStatementBytes: 2_000,
      });
    }
  }, 120_000);

  test.each([
    ["pub78", 119],
    ["revocation", 23],
    ["epostcard", 92],
  ] as const)(
    "of %s unflags the orgs it no longer lists, and only those",
    async (list, stillListed) => {
      const unlisted = UNLISTED[list].map((ein) => `'${ein}'`).join(", ");
      expect(
        await query(
          d1,
          `SELECT ein, ${LISTED[list]} AS listed FROM orgs WHERE ein IN (${unlisted}) ORDER BY ein`,
        ),
      ).toStrictEqual(UNLISTED[list].map((ein) => ({ ein, listed: 0 })));
      expect(
        await query(
          d1,
          `SELECT count(*) AS listed FROM orgs WHERE ${LISTED[list]}`,
        ),
      ).toStrictEqual([{ listed: stillListed }]);
    },
  );
});

describe("shared facts", { timeout: 60_000 }, () => {
  const SOURCES = ["bmf", "pub78", "revocation", "epostcard"] as const;
  type Source = (typeof SOURCES)[number];
  let forward: string;
  let backward: string;

  function load(persistTo: string, source: Source) {
    return source === "bmf" ? loadBmf(persistTo) : loadList(persistTo, source);
  }

  beforeAll(async () => {
    [forward, backward] = await Promise.all([
      freshD1("forward"),
      freshD1("backward"),
    ]);
    for (const source of SOURCES) await load(forward, source);
    for (const source of [...SOURCES].reverse()) await load(backward, source);
  }, 180_000);

  test.each([
    [
      "the BMF over Pub 78 and the revocation list",
      "010011694",
      {
        name: "MASSACHUSETTS MODERATORS ASSOCIATION INC",
        name_source: "bmf",
        street: "PO BOX 1281",
        city: "HAVERHILL",
        state: "MA",
        zip: "01831-1781",
        address_source: "bmf",
      },
    ],
    [
      "Pub 78 over the revocation list",
      "232320551",
      {
        name: "Interfaith Council on the Holocaust",
        name_source: "pub78",
        street: null,
        city: "Philadelphia",
        state: "PA",
        zip: null,
        address_source: "pub78",
      },
    ],
  ] as const)("take %s, whichever runs first", async (_, ein, expected) => {
    const sql = `SELECT o.name, n.source AS name_source, o.street, o.city, o.state, o.zip,
        a.source AS address_source
      FROM orgs o
      JOIN import_runs n ON n.id = o.name_run_id
      JOIN import_runs a ON a.id = o.address_run_id
      WHERE o.ein = '${ein}'`;
    expect(await query(forward, sql)).toStrictEqual([expected]);
    expect(await query(backward, sql)).toStrictEqual([expected]);
  });

  test("land the same for every org whichever source runs first", async () => {
    expect(await everyOrg(backward)).toStrictEqual(await everyOrg(forward));
  });

  test("are unchanged by running every source again", async () => {
    const before = await everyOrg(forward);
    const runs = await query(
      forward,
      "SELECT count(*) AS runs FROM import_runs",
    );
    for (const source of SOURCES) await load(forward, source);
    expect(await everyOrg(forward)).toStrictEqual(before);
    expect(
      await query(forward, "SELECT count(*) AS runs FROM import_runs"),
    ).toStrictEqual([{ runs: (runs[0] as { runs: number }).runs + 7 }]);
  }, 120_000);
});

/** Every org, each fact with the source that wrote it rather than its run id. */
function everyOrg(persistTo: string) {
  return query(
    persistTo,
    `SELECT o.ein, o.name, n.source AS name_source, o.street, o.city, o.state, o.zip,
      a.source AS address_source, b.source AS bmf_source, o.subsection, o.ntee, o.ruling_date,
      o.deductibility_code, o.filing_requirement_code, o.in_pub78, o.revocation_date,
      o.reinstatement_date, o.files_990n, o.epostcard_website
    FROM orgs o
    LEFT JOIN import_runs n ON n.id = o.name_run_id
    LEFT JOIN import_runs a ON a.id = o.address_run_id
    LEFT JOIN import_runs b ON b.id = o.bmf_run_id
    ORDER BY o.ein`,
  );
}

test("an EIN listed twice keeps its latest revocation whichever row comes first", {
  timeout: 60_000,
}, async () => {
  const d1 = await freshD1("swapped");
  await loadList(d1, "revocation", { path: "/swapped/revocation.zip" });
  const rows = await query(
    d1,
    "SELECT revocation_date, reinstatement_date FROM orgs WHERE ein = '010043788'",
  );
  expect(rows).toStrictEqual([
    { revocation_date: "2019-03-15", reinstatement_date: "2020-05-15" },
  ]);
});

test("a download that stalls is cut off and the load restarted, saying so", {
  timeout: 60_000,
}, async () => {
  const d1 = await freshD1("stall-once");
  const retry = quickRetry();

  const summary = await loadList(d1, "pub78", {
    path: "/stall-once/pub78.zip",
    retry,
  });

  expect(summary.rows).toBe(FIXTURE_ROWS.pub78);
  expect(retry.lines).toStrictEqual([
    `Pub 78 load failed (Pub 78 download failed: ${base}/stall-once/pub78.zip: no data for 0.5 s); try 2 of 3 in 0.0 s`,
  ]);
});

test("a load fenced for another build than the slot is building aborts, writing nothing", {
  timeout: 60_000,
}, async () => {
  const d1 = await freshD1("fenced");
  const before = await counts(d1);

  await expect(
    importList("pub78", {
      url: `${base}/pub78.zip`,
      minRows: 1,
      out: join(work, "fenced.load.sql"),
      target: { ...loadTarget(d1), buildId: "a-later-build" },
    }),
  ).rejects.toThrow("load refused: this slot is not building the load's build");
  expect(await counts(d1)).toStrictEqual(before);
});

function counts(persistTo: string) {
  return query(
    persistTo,
    "SELECT (SELECT count(*) FROM orgs) AS orgs, (SELECT count(*) FROM import_runs) AS runs",
  );
}

test("a later release keeping only an EIN's older revocation takes that one and its reinstatement", {
  timeout: 60_000,
}, async () => {
  const d1 = await freshD1("older");
  await loadList(d1, "revocation");
  await loadList(d1, "revocation", { path: "/older/revocation.zip" });
  const rows = await query(
    d1,
    "SELECT revocation_date, reinstatement_date FROM orgs WHERE ein = '010043788'",
  );
  expect(rows).toStrictEqual([
    { revocation_date: "2016-03-15", reinstatement_date: "2016-08-15" },
  ]);
});

test("a zip's first file loads without waiting on the rest of the archive", {
  timeout: 30_000,
}, async () => {
  const d1 = await freshD1("trailing");
  const summary = await loadList(d1, "pub78", { path: "/trailing/pub78.zip" });
  expect(summary.rows).toBe(FIXTURE_ROWS.pub78);
});

/** An org's name and address with the source of each. */
function orgWithSources(ein: string): string {
  return `SELECT o.name, n.source AS name_source, o.street, o.city, o.state, o.zip,
      a.source AS address_source, o.bmf_run_id, o.in_pub78
    FROM orgs o
    LEFT JOIN import_runs n ON n.id = o.name_run_id
    LEFT JOIN import_runs a ON a.id = o.address_run_id
    WHERE o.ein = '${ein}'`;
}
