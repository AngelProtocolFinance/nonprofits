/**
 * An Error is logged as text: `wrangler dev` stalls when handed the object.
 * Its stack goes too, so a code bug reads apart from a storage outage.
 */
export function logFailure(event: string, cause: unknown) {
  console.error(
    JSON.stringify(
      cause instanceof Error
        ? {
            event,
            cause: `${cause.name}: ${cause.message}`,
            stack: cause.stack,
          }
        : { event, cause },
    ),
  );
}
