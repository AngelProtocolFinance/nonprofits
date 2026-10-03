import { parseArgs } from "node:util";

export interface Io {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `Usage:
  keys create --email <owner-email> [--name <key-name>]
  keys revoke <key-id>

Calls the Worker at NONPROFITS_URL (default http://localhost:8787) with ADMIN_TOKEN.
`;

const DEFAULT_URL = "http://localhost:8787";

/** A problem-details body's `code: detail`, or the raw status when there is none. */
async function describeRefusal(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (typeof body === "object" && body !== null && "code" in body) {
    const { code, detail } = body as { code: unknown; detail?: unknown };
    return `${String(code)}: ${String(detail ?? "")}`;
  }
  return `HTTP ${response.status}`;
}

/** Runs one CLI command; returns the process exit code. */
export async function run(args: string[], io: Io): Promise<number> {
  const adminToken = io.env.ADMIN_TOKEN;
  const baseUrl = io.env.NONPROFITS_URL ?? DEFAULT_URL;
  const [command, ...rest] = args;

  let path: string;
  let body: Record<string, string>;
  try {
    if (command === "create") {
      const { values } = parseArgs({
        args: rest,
        options: { email: { type: "string" }, name: { type: "string" } },
      });
      if (values.email === undefined) throw new Error("--email is required");
      path = "/admin/keys";
      body = {
        email: values.email,
        ...(values.name === undefined ? {} : { name: values.name }),
      };
    } else if (command === "revoke") {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true });
      const [keyId] = positionals;
      if (keyId === undefined || positionals.length > 1) {
        throw new Error("revoke takes exactly one <key-id>");
      }
      path = `/admin/keys/${encodeURIComponent(keyId)}/revoke`;
      body = {};
    } else {
      throw new Error(
        command === undefined ? "no command" : `unknown command ${command}`,
      );
    }
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
    response = await fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
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
  } else {
    const { id } = (await response.json()) as { id: string };
    io.stderr(`Revoked key ${id}.\n`);
  }
  return 0;
}
