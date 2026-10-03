export const SERVICE_NAME = "nonprofits";

export { normalizeEin } from "./ein.ts";
export { lookupOrg } from "./lookup.ts";
export type * from "./org.ts";
export type { Result } from "./result.ts";
export { is501c3, isDeductible, isRevoked } from "./rules.ts";
export type * from "./search.ts";
export { searchOrgs } from "./search.ts";
