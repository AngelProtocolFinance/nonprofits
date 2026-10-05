/**
 * A count var as a positive integer, or null when it is none. A var set as
 * text arrives as a string, and SQLite sorts every number below every string,
 * so a limit bound as text would never refuse.
 */
export function countOf(value: unknown): number | null {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}
