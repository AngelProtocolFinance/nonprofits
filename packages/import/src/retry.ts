/** How often, and how far apart, a step that failed transiently is tried again. */
export interface RetryPolicy {
  /** Tries in all, the first included. */
  attempts: number;
  /** The wait before the second try; each later wait doubles, up to `maxDelayMs`. Each is then scaled by a random 50–100%. */
  firstDelayMs: number;
  maxDelayMs: number;
  /** Told of each retry, one line. */
  log?: (line: string) => void;
}

/** A run's retries: 4 tries, about 2 s, 4 s and 8 s apart, each logged to stderr. */
export const RETRY: RetryPolicy = {
  attempts: 4,
  firstDelayMs: 2_000,
  maxDelayMs: 16_000,
  log: (line) => console.error(line),
};

/** A failure another try may clear: a dropped connection, a stalled body, an HTTP 5xx or 429. */
export class TransientError extends Error {}

/**
 * Runs `step`, trying it again while it fails with an error `transient`
 * accepts and `policy` allows another try; rethrows the last failure.
 */
export async function retrying<T>(
  what: string,
  policy: RetryPolicy,
  step: () => Promise<T>,
  transient: (error: unknown) => boolean = (error) =>
    error instanceof TransientError,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      if (attempt >= policy.attempts || !transient(error)) throw error;
      const ceiling = Math.min(
        policy.maxDelayMs,
        policy.firstDelayMs * 2 ** (attempt - 1),
      );
      const delay = ceiling * (0.5 + Math.random() / 2);
      policy.log?.(
        `${what} failed (${oneLine(error)}); try ${attempt + 1} of ${policy.attempts} in ${(delay / 1000).toFixed(1)} s`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function oneLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim();
}
