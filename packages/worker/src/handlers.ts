import {
  lookupOrg,
  type OrgLookupError,
  type OrgResponse,
  type Result,
} from "@irs-lookup/core";
import { D1OrgReader } from "./d1-org-reader.ts";

/** What every transport (REST, MCP) hands a handler. */
export interface HandlerContext {
  env: Env;
  credential: string | null;
  now: Date;
}

/** Every refusal a handler can return; transports map each `code`. */
export type HandlerError = OrgLookupError;

/** Gate, then quota. Admits every caller until API keys and quotas exist. */
async function admit(
  _ctx: HandlerContext,
): Promise<Result<null, HandlerError>> {
  return { ok: true, value: null };
}

function emit(metrics: { event: string; outcome: string; rowsRead: number }) {
  console.log(JSON.stringify(metrics));
}

export async function lookup(
  ein: string,
  ctx: HandlerContext,
): Promise<Result<OrgResponse, HandlerError>> {
  const admitted = await admit(ctx);
  if (!admitted.ok) return admitted;

  let rowsRead = 0;
  const reader = new D1OrgReader(ctx.env.DB, (rows) => {
    rowsRead += rows;
  });
  const result = await lookupOrg(ein, reader);
  emit({
    event: "org_lookup",
    outcome: result.ok ? "ok" : result.error.code,
    rowsRead,
  });
  return result;
}
