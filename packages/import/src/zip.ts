import { Unzip, UnzipInflate } from "fflate";

/**
 * The first file in a zip archive, inflated as the archive streams in: each
 * chunk read is decompressed and handed on before the next is read, so memory
 * stays at one chunk's worth whatever the archive's size. A body that isn't a
 * zip, or ends before that file does, throws.
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
  }
  unzip.push(new Uint8Array(0), true);
  yield* drain();
  if (!ended) throw new Error("zip archive holds no complete file");
}
