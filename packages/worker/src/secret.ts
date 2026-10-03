// an unset secret reads as undefined; the floor also refuses a guessable one
export const MIN_SECRET_LENGTH = 32;
// `.dev.vars.example`'s value: long enough to pass the floor, and public
const PLACEHOLDER = "replace-with-32-plus-random-characters";

/** Whether the operator set this secret to something only they know. */
export function isSecretSet(secret: string | undefined): secret is string {
  return (
    secret !== undefined &&
    secret.length >= MIN_SECRET_LENGTH &&
    secret !== PLACEHOLDER
  );
}
