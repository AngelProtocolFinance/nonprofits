/** BMF subsection `03`; unknown when the org is not in the current BMF. */
export function is501c3(bmf: { subsection: string } | null): boolean | null {
  return bmf === null ? null : bmf.subsection === "03";
}

/** Listed in Pub 78; unknown until Pub 78 is imported. */
export function isDeductible(
  pub78: { listed: boolean } | null,
): boolean | null {
  return pub78 === null ? null : pub78.listed;
}

/**
 * Revoked unless reinstated since; unknown until the revocation list is
 * imported. Dates are `YYYY-MM-DD`, so they compare as strings.
 */
export function isRevoked(
  revocation: { revokedOn: string | null; reinstatedOn: string | null } | null,
): boolean | null {
  if (revocation === null) return null;
  const { revokedOn, reinstatedOn } = revocation;
  return (
    revokedOn !== null && (reinstatedOn === null || reinstatedOn < revokedOn)
  );
}
