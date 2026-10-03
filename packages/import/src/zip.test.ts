import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { zipEntries } from "./zip.ts";

const EFILE_FIXTURES = new URL("../fixtures/efile/", import.meta.url);

test("a Deflate64 entry from an IRS batch zip inflates", async () => {
  // one entry cut from 2026_TEOS_XML_05B.zip with its compressed bytes untouched
  const path = fileURLToPath(new URL("deflate64.zip", EFILE_FIXTURES));
  const read: [string, string][] = [];
  for await (const entry of zipEntries(path)) {
    read.push([entry.name, await new Response(entry.read()).text()]);
  }
  // the fixture holds the same return trimmed after its form
  const trimmed = await readFile(
    new URL("xml/202631339349308133_public.xml", EFILE_FIXTURES),
    "utf8",
  );
  // Response#text drops the byte-order mark readFile keeps
  const form = trimmed.slice(1, trimmed.indexOf("</IRS990>"));
  expect(read).toHaveLength(1);
  expect(read[0]?.[0]).toBe("202631339349308133_public.xml");
  expect(read[0]?.[1].startsWith(form)).toBe(true);
});
