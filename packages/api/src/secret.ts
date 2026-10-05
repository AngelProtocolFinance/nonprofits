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
