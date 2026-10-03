const MINUTE_MS = 60_000;

/** Waits for the next window when less than `neededMs` of the current `periodMs` one is left. */
async function clearOfWindowEnd(periodMs: number, neededMs: number) {
  const left = periodMs - (Date.now() % periodMs);
  if (left >= neededMs) return;
  await new Promise((resolve) => setTimeout(resolve, left + 1000));
}

/**
 * The local Rate Limiting binding counts in wall-clock minutes: a burst
 * started in a minute's last seconds would be split across two windows. A
 * burst that takes longer than the default margin passes its own cost, as
 * `startOfBurstWindow` measures it.
 */
export function startOfMinuteWindow(neededMs = 10_000): Promise<void> {
  return clearOfWindowEnd(MINUTE_MS, neededMs);
}

/**
 * Waits for a minute window that `requests` calls fit in, judging their cost
 * by `probes` calls of `send`. The probes must not touch the counter the burst
 * counts in, and `send` must cost what a burst request does.
 */
export async function startOfBurstWindow(
  requests: number,
  send: () => Promise<unknown>,
  probes = 20,
): Promise<void> {
  const started = performance.now();
  for (let i = 0; i < probes; i++) await send();
  const perRequestMs = (performance.now() - started) / probes;
  // twice the measured cost, for a runner that slows down mid-burst, and a margin
  const neededMs = Math.ceil(perRequestMs * requests * 2) + 5_000;
  if (neededMs >= MINUTE_MS) {
    throw new Error(
      `${requests} requests at ${perRequestMs.toFixed(1)} ms each can't be held inside one minute window`,
    );
  }
  await startOfMinuteWindow(neededMs);
}

/**
 * Daily counts key on the Worker's own clock, so a run across UTC midnight
 * would split them. Sleeps up to 31 s: a test that calls it needs a timeout
 * past that (the workerd project's, in vitest.config.ts).
 */
export function clearOfUtcMidnight(): Promise<void> {
  return clearOfWindowEnd(24 * 60 * MINUTE_MS, 30_000);
}
