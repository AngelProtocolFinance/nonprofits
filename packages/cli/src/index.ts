import { parseArgs } from "node:util";

export interface Io {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `Usage:
  keys create --email <owner-email> [--name <key-name>]
  keys revoke <key-id>
  keys list
  keys set-limit <key-id> --daily <n> --per-minute <n>
  keys set-limit <key-id> --default

Calls the Worker at NONPROFITS_URL (default http://localhost:8787) with ADMIN_TOKEN.
`;

const DEFAULT_URL = "http://localhost:8787";

const SET_LIMIT_USAGE =
  "set-limit takes <key-id> and either --daily <n> --per-minute <n> (positive integers) or --default";

interface AdminCall {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: Record<string, string | number>;
}

interface Limits {
  id: string;
  tier: "default" | "whitelisted";
  daily: number;
  perMinute: number;
}

interface ListedKey extends Limits {
  name: string | null;
  ownerEmail: string;
  status: "active" | "revoked";
  usedToday: number;
}

/** A problem-details body's `code: detail`, or the raw status when there is none. */
async function describeRefusal(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (typeof body === "object" && body !== null && "code" in body) {
    const { code, detail } = body as { code: unknown; detail?: unknown };
    return `${String(code)}: ${String(detail ?? "")}`;
  }
  return `HTTP ${response.status}`;
}

function onlyKeyId(positionals: string[], command: string): string {
  const [keyId] = positionals;
  if (keyId === undefined || positionals.length > 1) {
    throw new Error(`${command} takes exactly one <key-id>`);
  }
  return keyId;
}

function keyPath(keyId: string, action: "revoke" | "limits"): string {
  return `/admin/keys/${encodeURIComponent(keyId)}/${action}`;
}

function setLimitCall(args: string[]): AdminCall {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      daily: { type: "string" },
      "per-minute": { type: "string" },
      default: { type: "boolean" },
    },
  });
  const [keyId] = positionals;
  const { daily, "per-minute": perMinute } = values;
  const isCount = (n: string | undefined): n is string =>
    n !== undefined && /^[1-9]\d*$/.test(n);
  if (keyId === undefined || positionals.length > 1) {
    throw new Error(SET_LIMIT_USAGE);
  }
  if (values.default && daily === undefined && perMinute === undefined) {
    return { method: "DELETE", path: keyPath(keyId, "limits") };
  }
  if (!values.default && isCount(daily) && isCount(perMinute)) {
    return {
      method: "PUT",
      path: keyPath(keyId, "limits"),
      body: { daily: Number(daily), perMinute: Number(perMinute) },
    };
  }
  throw new Error(SET_LIMIT_USAGE);
}

/** The admin call a command line asks for; throws a usage error otherwise. */
function adminCall(command: string | undefined, rest: string[]): AdminCall {
  switch (command) {
    case "create": {
      const { values } = parseArgs({
        args: rest,
        options: { email: { type: "string" }, name: { type: "string" } },
      });
      if (values.email === undefined) throw new Error("--email is required");
      return {
        method: "POST",
        path: "/admin/keys",
        body: {
          email: values.email,
          ...(values.name === undefined ? {} : { name: values.name }),
        },
      };
    }
    case "revoke": {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true });
      return {
        method: "POST",
        path: keyPath(onlyKeyId(positionals, "revoke"), "revoke"),
        body: {},
      };
    }
    case "list":
      parseArgs({ args: rest });
      return { method: "GET", path: "/admin/keys" };
    case "set-limit":
      return setLimitCall(rest);
    default:
      throw new Error(
        command === undefined ? "no command" : `unknown command ${command}`,
      );
  }
}

/** Columns padded to their widest cell, two spaces apart. */
function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, i) =>
    Math.max(...rows.map((row) => row[i]?.length ?? 0)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths?.[i] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .map((line) => `${line}\n`)
    .join("");
}

/** Runs one CLI command; returns the process exit code. */
export async function run(args: string[], io: Io): Promise<number> {
  const adminToken = io.env.ADMIN_TOKEN;
  const baseUrl = io.env.NONPROFITS_URL ?? DEFAULT_URL;
  const [command, ...rest] = args;

  let call: AdminCall;
  try {
    call = adminCall(command, rest);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (!adminToken) {
    io.stderr("Set ADMIN_TOKEN to the Worker's ADMIN_TOKEN secret.\n");
    return 2;
  }

  let response: Response;
  try {
    response = await fetch(new URL(call.path, baseUrl), {
      method: call.method,
      headers: {
        authorization: `Bearer ${adminToken}`,
        ...(call.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
    });
  } catch {
    // fetch rejects only when no HTTP response came back: refused, DNS, TLS
    io.stderr(
      `Can't reach the Worker at ${baseUrl} (NONPROFITS_URL). Start it locally with \`pnpm --filter @nonprofits/worker dev\` (wrangler dev), or point NONPROFITS_URL at the deployed Worker.\n`,
    );
    return 1;
  }
  if (!response.ok) {
    io.stderr(`${await describeRefusal(response)}\n`);
    return 1;
  }

  if (command === "create") {
    const issued = (await response.json()) as {
      id: string;
      key: string;
      name: string | null;
      ownerEmail: string;
    };
    const named = issued.name === null ? "" : ` ("${issued.name}")`;
    // the key alone on stdout, so `keys create … > file` captures just the key
    io.stdout(`${issued.key}\n`);
    io.stderr(
      `Created key ${issued.id}${named} for ${issued.ownerEmail}. It is shown once: store it now.\n`,
    );
  } else if (command === "revoke") {
    const { id } = (await response.json()) as { id: string };
    io.stderr(`Revoked key ${id}.\n`);
  } else if (command === "list") {
    const { keys } = (await response.json()) as { keys: ListedKey[] };
    io.stdout(
      table([
        ["ID", "NAME", "OWNER", "STATUS", "TIER", "DAILY", "PER_MIN", "TODAY"],
        ...keys.map((key) => [
          key.id,
          key.name ?? "-",
          key.ownerEmail,
          key.status,
          key.tier,
          String(key.daily),
          String(key.perMinute),
          String(key.usedToday),
        ]),
      ]),
    );
  } else {
    const { id, tier, daily, perMinute } = (await response.json()) as Limits;
    const state =
      tier === "whitelisted" ? "is whitelisted" : "is on the default limits";
    io.stderr(`Key ${id} ${state}: ${daily}/day, ${perMinute}/min.\n`);
  }
  return 0;
}
