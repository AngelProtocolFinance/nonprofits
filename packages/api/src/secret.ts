import { createHash, timingSafeEqual } from "node:crypto";

// an unset secret reads as undefined; the floor also refuses a guessable one
export const MIN_SECRET_LENGTH = 32;
// the start of every placeholder in the example env files: each passes the floor, and is public
const PLACEHOLDER_PREFIX = "replace-with-";

/** Whether the operator set this secret to something only they know. */
export function isSecretSet(secret: string | undefined): secret is string {
  return (
    secret !== undefined &&
    secret.length >= MIN_SECRET_LENGTH &&
    !secret.startsWith(PLACEHOLDER_PREFIX)
  );
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

/** Whether `authorization` is `Bearer <secret>`; compares digests, which are equal length, so the compare is constant-time. */
export function isBearerOf(
  authorization: string | undefined,
  secret: string,
): boolean {
  return timingSafeEqual(
    sha256(authorization ?? ""),
    sha256(`Bearer ${secret}`),
  );
}
