/**
 * Days for a test that passes a handler its own `now`. They fall in 2001, in
 * the past, so no request stamped by the real clock lands on one: a test
 * keeps its `key_usage` rows apart from every real-clock test's, whatever day
 * the suite runs.
 */
export function virtualDay(n: number): string {
  return new Date(Date.UTC(2001, 0, n)).toISOString().slice(0, 10);
}

/** An instant on virtual day `n`, as `time` ("12:00:00") reads. */
export function virtualAt(n: number, time = "12:00:00"): string {
  return `${virtualDay(n)}T${time}Z`;
}

/** The UTC midnight that ends virtual day `n`, as a refusal message writes it. */
export function virtualMidnightAfter(n: number): string {
  return virtualAt(n + 1, "00:00:00");
}
