import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { firstZipEntry, LayoutDriftError, zipEntries } from "./zip.ts";

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

test("a Deflate64 entry streamed a few bytes at a time inflates", async () => {
  const bytes = await readFile(new URL("deflate64.zip", EFILE_FIXTURES));
  const parts: Uint8Array[] = [];
  for await (const chunk of firstZipEntry(slices(bytes, 3))) parts.push(chunk);
  const text = await new Response(new Blob(parts)).text();
  const trimmed = await readFile(
    new URL("xml/202631339349308133_public.xml", EFILE_FIXTURES),
    "utf8",
  );
  const form = trimmed.slice(1, trimmed.indexOf("</IRS990>"));
  expect(text.startsWith(form)).toBe(true);
});

test("a compression method fflate cannot inflate is a layout error", async () => {
  let caught: unknown;
  try {
    for await (const chunk of firstZipEntry(slices(methodZip(14), 1))) {
      void chunk;
    }
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LayoutDriftError);
  expect(caught).toMatchObject({
    name: "LayoutDriftError",
    message: "zip uses compression method 14",
  });
});

/** `bytes` in slices of `size`, so a header can span reads. */
async function* slices(
  bytes: Uint8Array,
  size: number,
): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) {
    yield bytes.subarray(i, i + size);
  }
}

/** A local file header of `method` with a few payload bytes and no central directory. */
function methodZip(method: number): Uint8Array {
  const name = new TextEncoder().encode("a.txt");
  const payload = new Uint8Array([1, 2, 3, 4]);
  const out = new Uint8Array(30 + name.length + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(8, method, true);
  view.setUint32(18, payload.length, true);
  view.setUint16(26, name.length, true);
  out.set(name, 30);
  out.set(payload, 30 + name.length);
  return out;
}
