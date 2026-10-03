const EIN_PATTERN = /^(\d{2})-?(\d{7})$/;

/** Returns the bare 9-digit EIN, or null when `input` is not `123456789` or `12-3456789`. */
export function normalizeEin(input: string): string | null {
  const match = EIN_PATTERN.exec(input);
  return match ? `${match[1]}${match[2]}` : null;
}
