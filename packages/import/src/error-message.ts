/**
 * `error`'s message, and its cause's: fetch fails with "fetch failed" alone,
 * its reason (undici's code and message) in `cause`. Redacted with the rest
 * where it is printed.
 */
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { cause } = error;
  if (!(cause instanceof Error)) return error.message;
  const code = (cause as { code?: unknown }).code;
  const why =
    typeof code === "string" ? `${code}: ${cause.message}` : cause.message;
  return `${error.message} (${why})`;
}
