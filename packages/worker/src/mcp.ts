import {
  type CallToolResult,
  createMcpHandler,
  McpServer,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import type { OrgResponse, OrgSearchResponse, Result } from "@nonprofits/core";
import { z } from "zod";
import {
  authorize,
  bearerCredential,
  type Caller,
  type HandlerError,
  limitKeylessMcpRequests,
  lookupAs,
  searchAs,
} from "./handlers.ts";
import { logFailure } from "./log.ts";
import { problem } from "./problem.ts";
import { refusalBody, refusalResponse } from "./refusal.ts";

/** Far above any tool call's arguments (a query is at most 200 characters). */
const MAX_BODY_BYTES = 16 * 1024;

const LOOKUP_DESCRIPTION = `Look up a US tax-exempt organization by its EIN (Employer Identification Number: the 9-digit number the IRS identifies an organization by). Pass it as a string, with or without the dash: "530196605" or "53-0196605".

Returns the organization's name, address, 501(c)(3) status, whether gifts to it are tax-deductible (IRS Pub 78), revocation status, mission, activity summary, top programs, latest finances and website. Every fact is read from IRS bulk data files, and \`provenance\` names the IRS file (and, for facts from a 990, the filing and tax year) each fact came from.

A fact is null when the IRS data doesn't carry it, and \`notes\` says why: \`mission\` is null for an organization that files only a 990-N postcard, for a 990-PF private foundation, or when its latest 990 states none.

Errors: \`invalid_ein\` for an EIN that isn't 9 digits, \`not_found\` when no organization has that EIN. Know only the name? Call search_nonprofits first. Each call counts against your daily quota.`;

const SEARCH_DESCRIPTION = `Find US tax-exempt organizations by name. Results are ranked by relevance to the words, best match first, with each match's EIN, name, city, state, 501(c)(3) status and deductibility; pass an EIN to lookup_nonprofit for the full record.

\`query\` is a few distinctive words of the name, 2 to 200 characters, e.g. "red cross"; punctuation is ignored and at most 8 words are used. \`limit\` is how many matches to return: a whole number from 1 to 50, default 10, and above 50 is capped at 50.

Names come from the IRS Business Master File. Each call counts against your daily quota.`;

/**
 * An EIN sent as a number, as the 9 digits it stands for: a number has lost
 * any leading zeros, and every EIN is 9 digits. Anything else is left for the
 * lookup to refuse.
 */
function einText(ein: string | number): string {
  return typeof ein === "number" && Number.isSafeInteger(ein) && ein >= 0
    ? String(ein).padStart(9, "0")
    : String(ein);
}

function yesNo(fact: boolean | null): string {
  return fact === null ? "unknown" : fact ? "yes" : "no";
}

function place(org: { city: string | null; state: string | null }): string {
  return [org.city, org.state].filter((part) => part !== null).join(", ");
}

function renderOrg(org: OrgResponse): string {
  const where = place(org.address);
  const lines = [
    `${org.name ?? "(no name on record)"}, EIN ${org.ein}${where === "" ? "" : `, ${where}`}`,
    `501(c)(3): ${yesNo(org.is501c3)}. Tax-deductible (Pub 78): ${yesNo(org.deductible)}. Revoked: ${yesNo(org.revoked)}.`,
    `Mission: ${org.mission ?? "none on record"}`,
  ];
  if (org.website !== null) lines.push(`Website: ${org.website}`);
  if (org.notes.length > 0) lines.push(`Notes: ${org.notes.join("; ")}`);
  return lines.join("\n");
}

function renderSearch(found: OrgSearchResponse): string {
  if (found.results.length === 0) return `No matches for "${found.query}".`;
  const matches = found.results.map((match, i) => {
    const where = place(match);
    return `${i + 1}. ${match.name}, EIN ${match.ein}${where === "" ? "" : `, ${where}`}`;
  });
  return [`Matches for "${found.query}", best first:`, ...matches].join("\n");
}

/**
 * A handler result as a tool result: the REST JSON as structured content, and
 * as text after a short rendering for clients that read only text. A refusal
 * is a tool error carrying the REST problem body.
 */
function toolResult<T extends OrgResponse | OrgSearchResponse>(
  result: Result<T, HandlerError>,
  render: (value: T) => string,
): CallToolResult {
  if (result.ok) {
    return {
      content: [
        { type: "text", text: render(result.value) },
        { type: "text", text: JSON.stringify(result.value) },
      ],
      structuredContent: { ...result.value },
    };
  }
  const body = refusalBody(result.error);
  return {
    isError: true,
    content: [{ type: "text", text: `${body.code}: ${body.detail}` }],
    structuredContent: body,
  };
}

function nonprofitsServer(caller: Caller): McpServer {
  const server = new McpServer(
    { name: "nonprofits", version: "1.0.0" },
    { capabilities: { tools: { listChanged: false } } },
  );
  server.registerTool(
    "lookup_nonprofit",
    {
      title: "Look up a nonprofit by EIN",
      description: LOOKUP_DESCRIPTION,
      inputSchema: z.object({
        // clients that parse arguments as JSON send a bare EIN as a number
        ein: z
          .union([z.string(), z.number()])
          .describe('9-digit EIN, e.g. "530196605" or "53-0196605"'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ ein }) =>
      toolResult(await lookupAs(einText(ein), caller), renderOrg),
  );
  server.registerTool(
    "search_nonprofits",
    {
      title: "Search nonprofits by name",
      description: SEARCH_DESCRIPTION,
      inputSchema: z.object({
        query: z.string().describe('A few words of the name, e.g. "red cross"'),
        // a plain number, so a fraction or 0 gets the REST invalid_limit
        // error rather than the SDK's schema error
        limit: z
          .number()
          .optional()
          .describe("Whole number of matches, 1 to 50; default 10"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) =>
      toolResult(await searchAs({ query, limit }, caller), renderSearch),
  );
  return server;
}

/** The body as text, or null past `limit` bytes, where reading stops. */
async function bodyText(
  request: Request,
  limit: number,
): Promise<string | null> {
  if (request.body === null) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new Blob(chunks).text();
}

type JsonRpcRequest = { method: string; id?: string | number | null };

function isListenRequest(message: unknown): message is JsonRpcRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "method" in message &&
    message.method === "subscriptions/listen"
  );
}

/** A `subscriptions/listen` among a POST's messages; malformed JSON is left for the SDK to answer. */
function listenRequestIn(body: string): JsonRpcRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).find(isListenRequest);
}

/**
 * The tools never change, so a listen stream would only hold a connection
 * open. Refused, not capped: `maxSubscriptions` counts per handler, and one is
 * built per request.
 */
function refuseListen(id: string | number | null): Response {
  return Response.json({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message:
        "subscriptions/listen is not offered: these tools never change, so there is nothing to notify.",
    },
  });
}

/**
 * `/mcp`: stateless streamable HTTP. The credential is checked once per HTTP
 * request, before any MCP message is read, so a bad key is a 401 even on the
 * handshake; each tool call is then counted like a REST request.
 */
export async function mcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return problem(405, "method_not_allowed", "Use POST.", { allow: "POST" });
  }
  // the MCP transport spec: servers MUST validate Origin, against DNS rebinding
  const crossOrigin = originValidationResponse(request, [
    new URL(request.url).hostname,
  ]);
  if (crossOrigin !== undefined) return crossOrigin;

  const authorized = await authorize(
    {
      credential: bearerCredential(request.headers.get("authorization")),
      clientIp: request.headers.get("cf-connecting-ip"),
      cfWorker: request.headers.get("cf-worker"),
    },
    env,
  );
  if (!authorized.ok) return refusalResponse(authorized.error);
  const limited = await limitKeylessMcpRequests(authorized.value, env);
  if (!limited.ok) return refusalResponse(limited.error);

  const body = await bodyText(request, MAX_BODY_BYTES);
  if (body === null) {
    return problem(
      413,
      "body_too_large",
      `An MCP request body is at most ${MAX_BODY_BYTES} bytes.`,
    );
  }
  const listen = listenRequestIn(body);
  if (listen !== undefined) return refuseListen(listen.id ?? null);

  const caller: Caller = { env, now: new Date(), principal: authorized.value };
  return createMcpHandler(() => nonprofitsServer(caller), {
    onerror: (error) => logFailure("mcp_error", error),
  }).fetch(
    new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body,
      signal: request.signal,
    }),
  );
}
