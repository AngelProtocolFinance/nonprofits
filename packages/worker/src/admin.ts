import { isAPIError } from "better-auth/api";
import { getAuth, MAX_KEY_NAME_LENGTH } from "./auth.ts";
import { problem } from "./problem.ts";

// an unset secret reads as undefined; the floor also refuses a guessable one
const MIN_ADMIN_TOKEN_LENGTH = 32;
// `.dev.vars.example`'s value: long enough to pass the floor, and public
const ADMIN_TOKEN_PLACEHOLDER = "replace-with-32-plus-random-characters";
const REVOKE_PATH = /^\/admin\/keys\/([^/]+)\/revoke$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** What the CLI prints on create; the only response that ever carries `key`. */
interface IssuedKey {
  id: string;
  key: string;
  name: string | null;
  ownerEmail: string;
  createdAt: string;
  expiresAt: string | null;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** The one better-auth user per owner email: reused if present, created if not. */
async function ownerFor(auth: ReturnType<typeof getAuth>, email: string) {
  const { internalAdapter } = await auth.$context;
  const existing = await internalAdapter.findUserByEmail(email);
  if (existing !== null) return existing.user;
  try {
    return await internalAdapter.createUser(
      { email, name: email },
      { method: "admin" },
    );
  } catch (error) {
    // a concurrent issue for the same new email created it first: email is UNIQUE
    const winner = await internalAdapter.findUserByEmail(email);
    if (winner !== null) return winner.user;
    throw error;
  }
}

async function createKey(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email)) {
    return problem(400, "invalid_request", "Send JSON with an owner `email`.");
  }
  const name = body.name;
  if (
    name !== undefined &&
    (typeof name !== "string" ||
      name.length < 1 ||
      name.length > MAX_KEY_NAME_LENGTH)
  ) {
    return problem(
      400,
      "invalid_request",
      `\`name\` is optional, 1 to ${MAX_KEY_NAME_LENGTH} characters.`,
    );
  }

  const auth = getAuth(env);
  const user = await ownerFor(auth, email);
  const created = await auth.api.createApiKey({
    body: { userId: user.id, ...(name === undefined ? {} : { name }) },
  });
  const issued: IssuedKey = {
    id: created.id,
    key: created.key,
    name: created.name,
    ownerEmail: user.email,
    createdAt: created.createdAt.toISOString(),
    expiresAt: created.expiresAt?.toISOString() ?? null,
  };
  return Response.json(issued, { status: 201 });
}

/** Disables the key, keeping its row so a later request is told it was revoked. */
async function revokeKey(keyId: string, env: Env): Promise<Response> {
  const auth = getAuth(env);
  const { adapter } = await auth.$context;
  // updateApiKey without a session acts for the `userId` it is given: the owner's
  const owned = await adapter.findOne<{ referenceId: string }>({
    model: "apikey",
    where: [{ field: "id", value: keyId }],
    select: ["referenceId"],
  });
  if (owned === null) {
    return problem(404, "key_not_found", `No key with id ${keyId}.`);
  }
  await auth.api.updateApiKey({
    body: { keyId, userId: owned.referenceId, enabled: false },
  });
  return Response.json({ id: keyId, status: "revoked" });
}

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

/** Compares digests, not strings: equal length, so the compare is constant-time. */
async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const [sent, expected] = await Promise.all([
    sha256(request.headers.get("authorization") ?? ""),
    sha256(`Bearer ${env.ADMIN_TOKEN}`),
  ]);
  return crypto.subtle.timingSafeEqual(sent, expected);
}

/** better-auth's own refusals keep their status; anything else is a problem 500, never a bare one. */
function failure(error: unknown): Response {
  if (isAPIError(error) && error.statusCode === 404) {
    return problem(404, "key_not_found", "No such key.");
  }
  if (isAPIError(error) && error.statusCode < 500) {
    return problem(400, "invalid_request", error.message);
  }
  console.error(
    JSON.stringify({
      event: "admin_failed",
      cause: error instanceof Error ? `${error.name}: ${error.message}` : error,
    }),
  );
  return problem(
    500,
    "internal_error",
    "The key operation failed on the server. Retry; if it keeps failing, check the Worker logs.",
  );
}

/** Operator-only key management under `/admin/`, for the key CLI. */
export async function admin(request: Request, env: Env): Promise<Response> {
  try {
    return await route(request, env);
  } catch (error) {
    return failure(error);
  }
}

async function route(request: Request, env: Env): Promise<Response> {
  if (
    (env.ADMIN_TOKEN?.length ?? 0) < MIN_ADMIN_TOKEN_LENGTH ||
    env.ADMIN_TOKEN === ADMIN_TOKEN_PLACEHOLDER
  ) {
    return problem(
      503,
      "admin_disabled",
      `Admin endpoints are off: set the ADMIN_TOKEN secret to at least ${MIN_ADMIN_TOKEN_LENGTH} random characters.`,
    );
  }
  if (!(await isAdmin(request, env))) {
    return problem(
      401,
      "admin_unauthorized",
      "Admin endpoints need `Authorization: Bearer <ADMIN_TOKEN>`.",
      { "www-authenticate": 'Bearer realm="nonprofits-admin"' },
    );
  }
  const { pathname } = new URL(request.url);
  if (pathname === "/admin/keys") {
    if (request.method !== "POST") {
      return problem(405, "method_not_allowed", "Use POST.", { allow: "POST" });
    }
    return createKey(request, env);
  }
  const revoke = REVOKE_PATH.exec(pathname);
  if (revoke?.[1] !== undefined) {
    if (request.method !== "POST") {
      return problem(405, "method_not_allowed", "Use POST.", { allow: "POST" });
    }
    let keyId: string;
    try {
      keyId = decodeURIComponent(revoke[1]);
    } catch {
      return problem(
        400,
        "invalid_request",
        "The key id in the path is not valid percent-encoding.",
      );
    }
    return revokeKey(keyId, env);
  }
  return problem(404, "route_not_found", `No route for ${pathname}.`);
}
