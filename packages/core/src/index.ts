export const SERVICE_NAME = "irs-lookup";

export { normalizeEin } from "./ein.ts";
export { lookupOrg } from "./lookup.ts";
export type * from "./org.ts";
export type { Result } from "./result.ts";
export { is501c3, isDeductible, isRevoked } from "./rules.ts";
