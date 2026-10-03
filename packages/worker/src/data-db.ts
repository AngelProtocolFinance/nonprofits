import {
  DATA_DB_BINDING,
  type DataSlot,
  READ_ACTIVE_SLOT_SQL,
} from "@nonprofits/db";
import { logFailure } from "./log.ts";

/** How long an isolate serves the slot it read before reading the pointer again. */
const POINTER_TTL_MS = 30_000;

/**
 * A resolver of the data DB `APP_DB`'s `data_generation` pointer names, with
 * its own cache: the slot it read is served for 30 s. While the pointer can't
 * be read it serves the last slot it read; with none, it throws.
 */
export function createActiveDataDb() {
  let known: { slot: DataSlot; readAt: number } | undefined;
  return async (env: Env, now: number): Promise<D1Database> => {
    if (known === undefined || now - known.readAt >= POINTER_TTL_MS) {
      try {
        const { results } = await env.APP_DB.prepare(READ_ACTIVE_SLOT_SQL).all<{
          active: DataSlot;
        }>();
        const row = results[0];
        if (row === undefined) throw new Error("data_generation has no row");
        known = { slot: row.active, readAt: now };
      } catch (error) {
        if (known === undefined) throw error;
        logFailure("data_pointer_unavailable", error);
      }
    }
    return env[DATA_DB_BINDING[known.slot]];
  };
}

/** The data DB this isolate serves; the import's flip moves every isolate within 30 s. */
export const activeDataDb = createActiveDataDb();
