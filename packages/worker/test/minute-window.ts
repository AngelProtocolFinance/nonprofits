/**
 * The local Rate Limiting binding counts in wall-clock minutes: a burst
 * started in a minute's last seconds would be split across two windows, so
 * this waits for the next one.
 */
export async function startOfMinuteWindow(): Promise<void> {
  const secondsIn = new Date().getUTCSeconds();
  if (secondsIn < 50) return;
  await new Promise((resolve) => setTimeout(resolve, (61 - secondsIn) * 1000));
}
