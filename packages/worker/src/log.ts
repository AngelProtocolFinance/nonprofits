/** An Error is logged as text: `wrangler dev` stalls when handed the object. */
export function logFailure(event: string, cause: unknown) {
  console.error(
    JSON.stringify({
      event,
      cause: cause instanceof Error ? `${cause.name}: ${cause.message}` : cause,
    }),
  );
}
