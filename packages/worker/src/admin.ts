import { isAPIError } from "better-auth/api";
import { type Auth, createAuth, MAX_KEY_NAME_LENGTH } from "./auth.ts";
import { problem } from "./problem.ts";
import {
  DEFAULT_LIMITS,
  type KeyTier,
  type Limits,
  limitsOf,
  utcDay,
} from "./quota.ts";
import { isSecretSet, MIN_SECRET_LENGTH } from "./secret.ts";

const KEY_PATH = /^\/admin\/keys\/([^/]+)\/(revoke|limits)$/;
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
async function ownerFor(auth: Auth, email: string) {
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

  const auth = createAuth(env);
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
  const auth = createAuth(env);
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

/** One row of `keys list`: never the key or its hash. */
interface ListedKey extends Limits {
  id: string;
  name: string | null;
  ownerEmail: string;
  status: "active" | "revoked";
  tier: KeyTier;
  usedToday: number;
}

const LIST_SQL = `
SELECT k.id, k.name, u.email AS ownerEmail, k.enabled, l.daily,
  l.per_minute AS perMinute, coalesce(g.requests, 0) AS usedToday
FROM apikey k
JOIN "user" u ON u.id = k.referenceId
LEFT JOIN key_limits l ON l.key_id = k.id
LEFT JOIN key_usage g ON g.subject = k.id AND g.day = ?1
ORDER BY k.createdAt, k.id`;

/** Every key with its limits and its usage so far in the current UTC day. */
async function listKeys(env: Env): Promise<Response> {
  const day = utcDay(new Date());
  const { results } = await env.APP_DB.prepare(LIST_SQL).bind(day).all<{
    id: string;
    name: string | null;
    ownerEmail: string;
    enabled: number | null;
    daily: number | null;
    perMinute: number | null;
    usedToday: number;
  }>();
  const keys = results.map(
    ({ enabled, daily, perMinute, ...key }): ListedKey => {
      const { tier, limits } = limitsOf(daily, perMinute);
      return {
        ...key,
        status: enabled === 0 ? "revoked" : "active",
        tier,
        ...limits,
      };
    },
  );
  return Response.json({ day, keys });
}

/** What `keys set-limit` prints: the key's tier and the limits it now has. */
interface KeyLimits extends Limits {
  id: string;
  tier: KeyTier;
}

const SET_LIMITS_SQL = `
INSERT INTO key_limits (key_id, daily, per_minute)
SELECT id, ?2, ?3 FROM apikey WHERE id = ?1
ON CONFLICT (key_id) DO UPDATE SET daily = excluded.daily, per_minute = excluded.per_minute
RETURNING key_id`;

function isLimit(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** Whitelists a key with its own limits, replacing any it had. */
async function setLimits(
  keyId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const { daily, perMinute } = await readJson(request);
  if (!isLimit(daily) || !isLimit(perMinute)) {
    return problem(
      400,
      "invalid_request",
      "Send JSON with `daily` and `perMinute`, each a positive integer.",
    );
  }
  const { results } = await env.APP_DB.prepare(SET_LIMITS_SQL)
    .bind(keyId, daily, perMinute)
    .all();
  if (results.length === 0) {
    return problem(404, "key_not_found", `No key with id ${keyId}.`);
  }
  const limits: KeyLimits = {
    id: keyId,
    tier: "whitelisted",
    daily,
    perMinute,
  };
  return Response.json(limits);
}

/** Returns a key to the default tier. */
async function clearLimits(keyId: string, env: Env): Promise<Response> {
  const [, key] = await env.APP_DB.batch([
    env.APP_DB.prepare("DELETE FROM key_limits WHERE key_id = ?1").bind(keyId),
    env.APP_DB.prepare("SELECT id FROM apikey WHERE id = ?1").bind(keyId),
  ]);
  if (key === undefined || key.results.length === 0) {
    return problem(404, "key_not_found", `No key with id ${keyId}.`);
  }
  const limits: KeyLimits = { id: keyId, tier: "default", ...DEFAULT_LIMITS };
  return Response.json(limits);
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
  if (!isSecretSet(env.ADMIN_TOKEN)) {
    return problem(
      503,
      "admin_disabled",
      `Admin endpoints are off: set the ADMIN_TOKEN secret to at least ${MIN_SECRET_LENGTH} random characters.`,
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
    if (request.method === "GET") return listKeys(env);
    if (request.method !== "POST") {
      return problem(405, "method_not_allowed", "Use GET or POST.", {
        allow: "GET, POST",
      });
    }
    return createKey(request, env);
  }
  const [, rawId, action] = KEY_PATH.exec(pathname) ?? [];
  if (rawId !== undefined) {
    const allowed = action === "revoke" ? ["POST"] : ["PUT", "DELETE"];
    if (!allowed.includes(request.method)) {
      return problem(
        405,
        "method_not_allowed",
        `Use ${allowed.join(" or ")}.`,
        {
          allow: allowed.join(", "),
        },
      );
    }
    let keyId: string;
    try {
      keyId = decodeURIComponent(rawId);
    } catch {
      return problem(
        400,
        "invalid_request",
        "The key id in the path is not valid percent-encoding.",
      );
    }
    if (action === "revoke") return revokeKey(keyId, env);
    if (request.method === "PUT") return setLimits(keyId, request, env);
    return clearLimits(keyId, env);
  }
  return problem(404, "route_not_found", `No route for ${pathname}.`);
}
