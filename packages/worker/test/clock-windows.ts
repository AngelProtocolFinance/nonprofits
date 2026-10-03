/** Waits for the next window when less than `marginMs` of the current `periodMs` one is left. */
async function clearOfWindowEnd(periodMs: number, marginMs: number) {
  const left = periodMs - (Date.now() % periodMs);
  if (left >= marginMs) return;
  await new Promise((resolve) => setTimeout(resolve, left + 1000));
}

/**
 * The local Rate Limiting binding counts in wall-clock minutes: a burst
 * started in a minute's last seconds would be split across two windows.
 */
export function startOfMinuteWindow(): Promise<void> {
  return clearOfWindowEnd(60_000, 10_000);
}

/** Daily counts key on the Worker's own clock, so a run across UTC midnight would split them. */
export function clearOfUtcMidnight(): Promise<void> {
  return clearOfWindowEnd(24 * 60 * 60_000, 30_000);
}
