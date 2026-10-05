import { createHash, timingSafeEqual } from "node:crypto";
import type { Client } from "@libsql/client";
import { Hono } from "hono";
import { type Auth, createAuth, MAX_KEY_NAME_LENGTH } from "./auth.ts";
import type { ApiVars } from "./handlers.ts";
import { clearKeyLimits, listKeyRows, setKeyLimits } from "./key-store.ts";
import { problem } from "./problem.ts";
import {
  DEFAULT_LIMITS,
  KEYED_REQUESTS_PER_MINUTE,
  type KeyTier,
  type Limits,
  limitsOf,
  utcDay,
} from "./quota.ts";
import { isSecretSet, MIN_SECRET_LENGTH } from "./secret.ts";

const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** What `keys create` prints; the only response that ever carries `key`. */
interface IssuedKey {
  id: string;
  key: string;
  name: string | null;
  ownerEmail: string;
  createdAt: string;
  expiresAt: string | null;
}

/** What the admin routes read besides the request. */
export interface AdminDeps {
  appDb: Client;
  vars: ApiVars;
  now: () => Date;
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

function sha256(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

/** Compares digests, not strings: equal length, so the compare is constant-time. */
function isAdmin(
  authorization: string | undefined,
  adminToken: string,
): boolean {
  return timingSafeEqual(
    sha256(authorization ?? ""),
    sha256(`Bearer ${adminToken}`),
  );
}

/** The secrets admin needs, checked in this order; outside production, better-auth signs with a public built-in secret when its own is unset. */
const ADMIN_SECRETS = ["ADMIN_TOKEN", "BETTER_AUTH_SECRET"] as const;

function keyNotFound(keyId: string): Response {
  return problem(404, "key_not_found", `No key with id ${keyId}.`);
}

/** What each route reads; `auth()` builds a fresh better-auth instance on every call (see `createAuth`). */
interface AdminContext {
  deps: AdminDeps;
  auth: () => Auth;
}

async function createKey(request: Request, ctx: AdminContext) {
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
  const auth = ctx.auth();
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
async function revokeKey(keyId: string, ctx: AdminContext) {
  const auth = ctx.auth();
  const { adapter } = await auth.$context;
  // updateApiKey without a session acts for the `userId` it is given: the owner's
  const owned = await adapter.findOne<{ referenceId: string }>({
    model: "apikey",
    where: [{ field: "id", value: keyId }],
    select: ["referenceId"],
  });
  if (owned === null) return keyNotFound(keyId);
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

/** Every key with its limits and its usage so far in the current UTC day. */
async function listKeys(ctx: AdminContext) {
  const day = utcDay(ctx.deps.now());
  const rows = await listKeyRows(ctx.deps.appDb, day);
  const keys = rows.map(({ enabled, daily, perMinute, ...key }): ListedKey => {
    const { tier, limits } = limitsOf(daily, perMinute);
    return {
      ...key,
      status: enabled === 0 ? "revoked" : "active",
      tier,
      ...limits,
    };
  });
  return Response.json({ day, keys });
}

/** What `keys set-limit` prints: the key's tier and the limits it now has. */
interface KeyLimits extends Limits {
  id: string;
  tier: KeyTier;
}

function isLimit(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** Whitelists a key with its own limits, replacing any it had. */
async function setLimits(keyId: string, request: Request, ctx: AdminContext) {
  const { daily, perMinute } = await readJson(request);
  if (!isLimit(daily) || !isLimit(perMinute)) {
    return problem(
      400,
      "invalid_request",
      "Send JSON with `daily` and `perMinute`, each a positive integer.",
    );
  }
  if (perMinute > KEYED_REQUESTS_PER_MINUTE) {
    return problem(
      400,
      "invalid_request",
      `\`perMinute\` can be at most ${KEYED_REQUESTS_PER_MINUTE}: every client is capped at ${KEYED_REQUESTS_PER_MINUTE} requests a minute carrying an API key, before the key is read, so a higher limit is never reached.`,
    );
  }
  if (!(await setKeyLimits(ctx.deps.appDb, keyId, { daily, perMinute }))) {
    return keyNotFound(keyId);
  }
  const limits: KeyLimits = {
    id: keyId,
    tier: "whitelisted",
    daily,
    perMinute,
  };
  return Response.json(limits);
}

async function clearLimits(keyId: string, ctx: AdminContext) {
  if (!(await clearKeyLimits(ctx.deps.appDb, keyId))) return keyNotFound(keyId);
  const limits: KeyLimits = { id: keyId, tier: "default", ...DEFAULT_LIMITS };
  return Response.json(limits);
}

/** Operator-only key management under `/admin/`, for the key CLI. */
export function adminRoutes(deps: AdminDeps) {
  const ctx: AdminContext = {
    deps,
    auth: () => createAuth(deps.appDb, deps.vars.BETTER_AUTH_SECRET ?? ""),
  };
  return new Hono()
    .use(async (c, next) => {
      const unset = ADMIN_SECRETS.find((name) => !isSecretSet(deps.vars[name]));
      if (unset !== undefined) {
        return problem(
          503,
          "admin_disabled",
          `Admin endpoints are off: set the ${unset} secret to at least ${MIN_SECRET_LENGTH} random characters.`,
        );
      }
      if (
        !isAdmin(c.req.header("authorization"), deps.vars.ADMIN_TOKEN ?? "")
      ) {
        return problem(
          401,
          "admin_unauthorized",
          "Admin endpoints need `Authorization: Bearer <ADMIN_TOKEN>`.",
          { "www-authenticate": 'Bearer realm="nonprofits-admin"' },
        );
      }
      await next();
    })
    .get("/keys", () => listKeys(ctx))
    .post("/keys", (c) => createKey(c.req.raw, ctx))
    .post("/keys/:id/revoke", (c) => revokeKey(c.req.param("id"), ctx))
    .put("/keys/:id/limits", (c) =>
      setLimits(c.req.param("id"), c.req.raw, ctx),
    )
    .delete("/keys/:id/limits", (c) => clearLimits(c.req.param("id"), ctx));
}
