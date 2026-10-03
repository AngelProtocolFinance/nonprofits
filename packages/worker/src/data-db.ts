import {
  DATA_DB_BINDING,
  type DataSlot,
  POINTER_TTL_MS,
  READ_ACTIVE_SLOT_SQL,
  READ_DATA_META_SQL,
} from "@nonprofits/db";
import { logFailure } from "./log.ts";

interface Pointer {
  active: DataSlot;
  build_id: string;
}

interface DataMeta {
  slot: DataSlot;
  build_id: string;
  state: "building" | "complete";
}

/**
 * The slot the pointer names, once that slot's own `data_meta` says it is that
 * slot, sealed for the pointer's build: a flip to a half-built or miswired
 * database is never served.
 */
async function servableSlot(env: Env): Promise<DataSlot> {
  const pointer = (
    await env.APP_DB.prepare(READ_ACTIVE_SLOT_SQL).all<Pointer>()
  ).results[0];
  if (pointer === undefined) throw new Error("data_generation has no row");
  const { active, build_id } = pointer;
  const meta = (
    await env[DATA_DB_BINDING[active]]
      .prepare(READ_DATA_META_SQL)
      .all<DataMeta>()
  ).results[0];
  if (
    meta?.slot !== active ||
    meta.build_id !== build_id ||
    meta.state !== "complete"
  ) {
    throw new Error(`slot ${active} is not sealed for build ${build_id}`);
  }
  return active;
}

/**
 * A resolver of the data DB `APP_DB`'s `data_generation` pointer names, with
 * its own cache: the slot it read is served for 30 s. While the pointer can't
 * be read, or names a slot not sealed for its build, it serves the last slot
 * it read for another 30 s; with none, it throws.
 */
export function createActiveDataDb() {
  let known: { slot: DataSlot; readAt: number } | undefined;
  return async (env: Env, now: number): Promise<D1Database> => {
    if (known === undefined || now - known.readAt >= POINTER_TTL_MS) {
      try {
        known = { slot: await servableSlot(env), readAt: now };
      } catch (error) {
        if (known === undefined) throw error;
        logFailure("data_pointer_unservable", error);
        known = { slot: known.slot, readAt: now };
      }
    }
    return env[DATA_DB_BINDING[known.slot]];
  };
}

/** The data DB this isolate serves; the import's flip moves every isolate within 30 s. */
export const activeDataDb = createActiveDataDb();
