import {
  DATA_DB_BINDING,
  type DataMeta,
  type DataSlot,
  FLIP_SETTLE_MS,
  isServable,
  POINTER_TTL_MS,
  type Pointer,
  READ_ACTIVE_SLOT_SQL,
  READ_DATA_META_SQL,
} from "@nonprofits/db";
import { logFailure } from "./log.ts";

/** The data DB a request reads, and the build it holds. */
export interface ServedData {
  db: D1Database;
  buildId: string;
}

/** The pointer, once the slot it names is servable (`isServable`). */
async function servablePointer(env: Env): Promise<Pointer> {
  const pointer = (
    await env.APP_DB.prepare(READ_ACTIVE_SLOT_SQL).all<Pointer>()
  ).results[0];
  if (pointer === undefined) throw new Error("data_generation has no row");
  const meta = (
    await env[DATA_DB_BINDING[pointer.active]]
      .prepare(READ_DATA_META_SQL)
      .all<DataMeta>()
  ).results[0];
  if (!isServable(pointer, meta)) {
    throw new Error(
      `slot ${pointer.active} is not sealed for build ${pointer.build_id}`,
    );
  }
  return pointer;
}

/**
 * A resolver of the data DB `APP_DB`'s `data_generation` pointer names, with
 * its own cache: the slot it read is served for `POINTER_TTL_MS`. While a
 * reread fails, or names a slot not sealed for its build, it serves the last
 * slot until `FLIP_SETTLE_MS` past the last read that succeeded, reading again
 * only then, and throws from there until a read succeeds: a build may reset
 * the slot a flip left once `FLIP_SETTLE_MS` has passed.
 */
export function createActiveDataDb() {
  let known: { slot: DataSlot; buildId: string; readAt: number } | undefined;
  let retryAt = 0;
  return async (env: Env, now: number): Promise<ServedData> => {
    if (
      known === undefined ||
      (now - known.readAt >= POINTER_TTL_MS && now >= retryAt)
    ) {
      try {
        const { active, build_id } = await servablePointer(env);
        known = { slot: active, buildId: build_id, readAt: now };
      } catch (error) {
        if (known === undefined || now - known.readAt >= FLIP_SETTLE_MS) {
          throw error;
        }
        logFailure("data_pointer_unservable", error);
        retryAt = known.readAt + FLIP_SETTLE_MS;
      }
    }
    return { db: env[DATA_DB_BINDING[known.slot]], buildId: known.buildId };
  };
}

/** The data DB this isolate serves; the import's flip moves every isolate within 30 s. */
export const activeDataDb = createActiveDataDb();
