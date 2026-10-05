import { createReadStream } from "node:fs";
import type { Client } from "@libsql/client";

/** Where a load is applied: one source's SQL file, into one build's data. */
export interface LoadTarget {
  /** Applies the load file `file`, all of it or none. */
  apply(file: string): Promise<void>;
}

/**
 * About how much SQL one call hands the driver, in UTF-16 units. The libsql
 * driver's `executeMultiple` takes time growing with the square of the SQL it
 * is given (20 MB of inserts: 48 s in one call, 0.2 s in 100 KB calls), and a
 * whole e-file load (~450 MB) nears the longest string V8 holds.
 */
export const LOAD_CHUNK_CHARS = 128 * 1024;

/** The data database `data` as a load target: each load file applies in one transaction. */
export function fileTarget(data: Client): LoadTarget {
  return {
    async apply(file) {
      const tx = await data.transaction("write");
      try {
        for await (const sql of statementChunks(file)) {
          await tx.executeMultiple(sql);
        }
        await tx.commit();
      } finally {
        tx.close();
      }
    },
  };
}

const QUOTE = "'".charCodeAt(0);
const SEMICOLON = ";".charCodeAt(0);

/**
 * `file`'s SQL in pieces of whole statements, each about `LOAD_CHUNK_CHARS`
 * long. A piece ends at a `;` outside a quoted literal: the loads write their
 * values as `'…'` literals (a quote inside doubled) and no comments or quoted
 * names, so single quotes alone say where a literal is. A cut inside a literal
 * would leave it unterminated, which fails the load rather than altering it.
 */
async function* statementChunks(file: string): AsyncGenerator<string> {
  let pending = "";
  let inLiteral = false;
  for await (const piece of createReadStream(file, {
    encoding: "utf8",
    highWaterMark: 64 * 1024,
  }) as AsyncIterable<string>) {
    let end = -1;
    for (let i = 0; i < piece.length; i++) {
      const c = piece.charCodeAt(i);
      if (c === QUOTE) inLiteral = !inLiteral;
      else if (c === SEMICOLON && !inLiteral) end = i + 1;
    }
    if (end === -1 || pending.length + end < LOAD_CHUNK_CHARS) {
      pending += piece;
      continue;
    }
    yield pending + piece.slice(0, end);
    pending = piece.slice(end);
  }
  if (pending.trim() !== "") yield pending;
}
