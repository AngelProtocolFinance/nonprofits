import { openAsBlob } from "node:fs";
import { BlobReader, ZipReader } from "@zip.js/zip.js";
import { Unzip, UnzipInflate } from "fflate";

/**
 * The first file in a zip archive, inflated as the archive streams in: each
 * chunk read is decompressed and handed on before the next is read, so memory
 * stays at one chunk's worth whatever the archive's size. Reading stops once
 * that file ends, which also ends the download of the rest. A body that isn't
 * a zip, or ends before that file does, throws.
 */
export async function* firstZipEntry(
  archive: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const inflated: Uint8Array[] = [];
  let failure: Error | undefined;
  let entered = false;
  let ended = false;
  const unzip = new Unzip((file) => {
    if (entered) return;
    entered = true;
    file.ondata = (error, data, final) => {
      if (error) failure ??= error;
      else inflated.push(data);
      if (final) ended = true;
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  const drain = function* () {
    if (failure) throw failure;
    yield* inflated.splice(0);
  };
  for await (const chunk of archive) {
    unzip.push(chunk);
    yield* drain();
    // returning closes `archive`, which cancels the rest of the download
    if (ended) return;
  }
  unzip.push(new Uint8Array(0), true);
  yield* drain();
  if (!ended) throw new Error("zip archive holds no complete file");
}

/** A file in a zip archive; `read` streams its content, inflated. */
export interface ZipEntry {
  name: string;
  read(): ReadableStream<Uint8Array>;
}

/**
 * The files of the zip archive at `path`, listed from its central directory
 * and each read by random access only when `read` is called, so memory holds
 * one file's chunks at a time whatever the archive's size. Deflate64 entries
 * (some IRS 990 batches use it) inflate like Deflate ones.
 */
export async function* zipEntries(path: string): AsyncGenerator<ZipEntry> {
  // a Blob from openAsBlob reads the file lazily, by range
  const zip = new ZipReader(new BlobReader(await openAsBlob(path)), {
    useWebWorkers: false,
  });
  try {
    for await (const entry of zip.getEntriesGenerator()) {
      if (entry.directory) continue;
      yield {
        name: entry.filename,
        read() {
          const { readable, writable } = new TransformStream<
            Uint8Array,
            Uint8Array
          >();
          // a failure once the data flows aborts `writable`, erroring `readable`;
          // one before (a bad local header) leaves it unlocked to abort here
          entry.getData(writable).catch((error: unknown) => {
            writable.abort(error).catch(() => {});
          });
          return readable;
        },
      };
    }
  } finally {
    await zip.close();
  }
}
