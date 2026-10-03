export type Result<T, E extends { code: string; message: string }> =
  | { ok: true; value: T }
  | { ok: false; error: E };
