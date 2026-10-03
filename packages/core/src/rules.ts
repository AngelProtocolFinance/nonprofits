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

type Revocation = { revokedOn: string | null; reinstatedOn: string | null };

/**
 * Revoked unless reinstated since, by the revocation list or the BMF; unknown
 * until the revocation list is imported.
 */
export function isRevoked(
  revocation: Revocation | null,
  bmf: { rulingDate: string | null } | null,
): boolean | null {
  if (revocation === null) return null;
  return revokedPerList(revocation) && !reinstatedPerBmf(revocation, bmf);
}

/**
 * The BMF ruling date is the month of the letter recognizing exemption; one
 * after the revocation month means the IRS recognized the org again, though the
 * revocation list can lag it with no reinstatement date. Months are `YYYY-MM`,
 * so they compare as strings.
 */
export function reinstatedPerBmf(
  revocation: Revocation | null,
  bmf: { rulingDate: string | null } | null,
): boolean {
  const rulingDate = bmf?.rulingDate ?? null;
  if (rulingDate === null || revocation === null) return false;
  return (
    revokedPerList(revocation) && rulingDate > revocation.revokedOn.slice(0, 7)
  );
}

/** Dates are `YYYY-MM-DD`, so they compare as strings. */
function revokedPerList(
  revocation: Revocation,
): revocation is Revocation & { revokedOn: string } {
  const { revokedOn, reinstatedOn } = revocation;
  return (
    revokedOn !== null && (reinstatedOn === null || reinstatedOn < revokedOn)
  );
}
