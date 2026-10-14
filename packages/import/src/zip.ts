import { createWriteStream, openAsBlob } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  BlobReader,
  ERR_BAD_FORMAT,
  ERR_CENTRAL_DIRECTORY_NOT_FOUND,
  ERR_EOCDR_LOCATOR_ZIP64_NOT_FOUND,
  ERR_EOCDR_NOT_FOUND,
  ERR_LOCAL_FILE_HEADER_NOT_FOUND,
  ZipReader,
} from "@zip.js/zip.js";
import { Unzip, UnzipInflate } from "fflate";

/** Deflate64, the method some IRS zips use. fflate's Unzip has no decoder for it. */
const DEFLATE64 = 9;
const LOCAL_FILE_HEADER = 0x04034b50;
const UNKNOWN_COMPRESSION = /^unknown compression type (\d+)$/;

/** A zip.js failure that means the body ended before it held a whole archive. */
const INCOMPLETE_ZIP = new Set([
  ERR_BAD_FORMAT,
  ERR_EOCDR_NOT_FOUND,
  ERR_EOCDR_LOCATOR_ZIP64_NOT_FOUND,
  ERR_CENTRAL_DIRECTORY_NOT_FOUND,
  ERR_LOCAL_FILE_HEADER_NOT_FOUND,
]);

/**
 * The archive uses a compression method the streaming reader does not inflate.
 * A list load reports it as layout drift, rather than a failed download.
 */
export class LayoutDriftError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LayoutDriftError";
  }
}

/**
 * The first file in a zip archive, inflated as the archive streams in: each
 * chunk read is decompressed and handed on before the next is read, so memory
 * stays at one chunk's worth whatever the archive's size. Reading stops once
 * that file ends, which also ends the download of the rest. A body that isn't
 * a zip, or ends before that file does, throws.
 *
 * A Deflate64 entry is written out and read through `zipEntries`, which
 * inflates it. The whole archive is read first, because that reader finds the
 * entry from the central directory. Any other method fflate cannot inflate
 * throws `LayoutDriftError`: fflate reports the method and then throws a
 * TypeError from the decoder it does not have, which would otherwise read as
 * a broken download.
 */
export async function* firstZipEntry(
  archive: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const iterator = archive[Symbol.asyncIterator]();
  const prefix: Uint8Array[] = [];
  let seen = 0;
  while (seen < 10) {
    const next = await iterator.next();
    if (next.done) break;
    prefix.push(next.value);
    seen += next.value.length;
  }
  const bytes = chain(prefix, iterator);
  if (compressionMethod(prefix) === DEFLATE64) {
    yield* deflate64Entry(bytes);
    return;
  }
  yield* inflateFirst(bytes);
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

async function* chain(
  prefix: readonly Uint8Array[],
  rest: AsyncIterator<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  try {
    yield* prefix;
    while (true) {
      const next = await rest.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await rest.return?.();
  }
}

/** The local header's compression method, when `chunks` begin with one. */
function compressionMethod(chunks: readonly Uint8Array[]): number | undefined {
  const header = new Uint8Array(10);
  let filled = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, header.length - filled);
    header.set(chunk.subarray(0, take), filled);
    filled += take;
    if (filled === header.length) break;
  }
  if (filled < header.length) return undefined;
  const view = new DataView(header.buffer);
  if (view.getUint32(0, true) !== LOCAL_FILE_HEADER) return undefined;
  return view.getUint16(8, true);
}

/**
 * A Deflate64 archive, inflated by `zipEntries`. The file is removed once the
 * first entry has been read, or the read has failed.
 */
async function* deflate64Entry(
  archive: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "deflate64-"));
  const path = join(dir, "archive.zip");
  try {
    await pipeline(Readable.from(archive), createWriteStream(path));
    let read = false;
    try {
      for await (const entry of zipEntries(path)) {
        read = true;
        yield* entryBytes(entry.read());
        break;
      }
    } catch (error) {
      if (!read && incompleteZip(error)) {
        throw new Error("zip archive holds no complete file", { cause: error });
      }
      const detail =
        error instanceof Error && error.message !== ""
          ? `: ${error.message}`
          : "";
      throw new LayoutDriftError(`zip uses Deflate64 compression${detail}`, {
        cause: error,
      });
    }
    if (!read) throw new Error("zip archive holds no complete file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function incompleteZip(error: unknown): boolean {
  return error instanceof Error && INCOMPLETE_ZIP.has(error.message);
}

async function* entryBytes(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function* inflateFirst(
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

  // an unknown method is handed to ondata and then thrown past: fflate still
  // constructs the decoder it does not have
  const raiseFailure = () => {
    const drift = compressionDrift(failure);
    if (drift) throw drift;
    if (failure) throw failure;
  };
  const push = (chunk: Uint8Array, final?: boolean) => {
    try {
      unzip.push(chunk, final);
    } catch (error) {
      raiseFailure();
      throw error;
    }
  };
  const drain = function* () {
    raiseFailure();
    yield* inflated.splice(0);
  };
  for await (const chunk of archive) {
    push(chunk);
    yield* drain();
    // returning closes `archive`, which cancels the rest of the download
    if (ended) return;
  }
  push(new Uint8Array(0), true);
  yield* drain();
  if (!ended) throw new Error("zip archive holds no complete file");
}

/** fflate's "unknown compression type N", named for the method. */
function compressionDrift(error: unknown): LayoutDriftError | undefined {
  if (!(error instanceof Error)) return undefined;
  const method = UNKNOWN_COMPRESSION.exec(error.message)?.[1];
  if (method === undefined) return undefined;
  const named =
    method === String(DEFLATE64)
      ? "Deflate64 compression"
      : `compression method ${method}`;
  return new LayoutDriftError(`zip uses ${named}`, { cause: error });
}
