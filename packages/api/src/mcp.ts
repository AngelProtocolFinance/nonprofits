import {
  type CallToolResult,
  createMcpHandler,
  McpServer,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import type { OrgResponse, OrgSearchResponse, Result } from "@nonprofits/core";
import { bodyLimit } from "hono/body-limit";
import { createFactory } from "hono/factory";
import { z } from "zod";
import { clientRequestOf } from "./authorize.ts";
import {
  authorizeAs,
  type Caller,
  type HandlerError,
  limitKeylessMcpRequests,
  lookupAs,
  type Service,
  searchAs,
} from "./handlers.ts";
import { logFailure } from "./log.ts";
import { problem } from "./problem.ts";
import { refusalBody, refuse } from "./refusal.ts";

/** Far above any tool call's arguments (a query is at most 200 characters). */
const MAX_BODY_BYTES = 16 * 1024;

/** Shared by the lookup and search tool descriptions and their output schemas. */
const DEDUCTIBLE_TRISTATE =
  "Tri-state: true when the organization is listed in IRS Publication 78, false when Publication 78 has been imported and the organization is not listed, and null when unknown (for example, Publication 78 has not been imported).";

const LOOKUP_DESCRIPTION = `Look up a US tax-exempt organization by its EIN (Employer Identification Number: the 9-digit number the IRS identifies an organization by). Pass it as a string, with or without the dash: "530196605" or "53-0196605".

Returns the organization's name, address, 501(c)(3) status, whether gifts to it are tax-deductible (IRS Pub 78), revocation status, mission, activity summary, top programs, latest finances and website. Every fact is read from IRS bulk data files, and \`provenance\` names the IRS file (and, for facts from a 990, the filing and tax year) each fact came from.

\`deductible\` is ${DEDUCTIBLE_TRISTATE}

A fact is null when the IRS data doesn't carry it, and \`notes\` says why. For example, \`mission\` is null for an organization that files only a 990-N postcard, for a 990-PF private foundation, or when its latest 990 states none or puts it on Schedule O, which isn't extracted.

Errors: \`invalid_ein\` for an EIN that isn't 9 digits, \`not_found\` when no organization has that EIN. Know only the name? Call search_nonprofits first. Each call counts against your daily quota, except one refused as \`invalid_ein\`.`;

const SEARCH_DESCRIPTION = `Find US tax-exempt organizations by name. Results are ranked by relevance to the words, best match first. Each match has its EIN, name, city, state, 501(c)(3) status, \`deductible\`, \`revoked\` and \`revocationDate\`. Pass an EIN to lookup_nonprofit for the full record.

\`deductible\` is ${DEDUCTIBLE_TRISTATE} \`revoked\` is true only when the exemption was revoked and has not been reinstated since, on the auto-revocation list or by a later Business Master File ruling month; a revoked-then-reinstated organization is not revoked. \`revocationDate\` is \`YYYY-MM-DD\` when the list has a date, and is still returned after a later reinstatement. \`revoked\` is null until that list is imported.

\`query\` is a few distinctive words of the name, 2 to 200 characters, e.g. "red cross"; punctuation is ignored and at most 8 words are used. \`limit\` is how many matches to return: a whole number from 1 to 50, default 10, and above 50 is capped at 50.

Names come from the IRS Business Master File. Each call counts against your daily quota, except one refused as \`invalid_query\` or \`invalid_limit\`.`;

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
 * is a tool error carrying the REST problem body (`refusalBody`).
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

const sourceFile = z.object({
  file: z.string(),
  releasedAt: z.string(),
  fetchedAt: z.string(),
});

const filingCitation = sourceFile.extend({
  objectId: z.string(),
  taxYear: z.number(),
  formType: z.enum(["990", "990-EZ", "990-PF"]),
});

/** `deductible` on both tools: true, false, or null when unknown. */
const deductible = z.boolean().nullable().describe(DEDUCTIBLE_TRISTATE);

const LOOKUP_OUTPUT = z.object({
  ein: z.string(),
  name: z.string().nullable(),
  address: z.object({
    street: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    zip: z.string().nullable(),
  }),
  is501c3: z.boolean().nullable(),
  deductible,
  revoked: z.boolean().nullable(),
  revocationDate: z.string().nullable(),
  reinstatementDate: z.string().nullable(),
  mission: z.string().nullable(),
  activitySummary: z.string().nullable(),
  programs: z.array(
    z.object({
      description: z.string().nullable(),
      expense: z.number().nullable(),
      grants: z.number().nullable(),
      revenue: z.number().nullable(),
    }),
  ),
  finances: z
    .object({
      revenue: z.number().nullable(),
      expenses: z.number().nullable(),
      assets: z.number().nullable(),
      taxYear: z.number(),
    })
    .nullable(),
  website: z.string().nullable(),
  notes: z.array(z.string()),
  provenance: z.object({
    name: sourceFile.nullable(),
    address: sourceFile.nullable(),
    is501c3: sourceFile.nullable(),
    deductible: sourceFile.nullable(),
    revoked: sourceFile.nullable(),
    revocationDate: sourceFile.nullable(),
    reinstatementDate: sourceFile.nullable(),
    mission: filingCitation.nullable(),
    activitySummary: filingCitation.nullable(),
    programs: filingCitation.nullable(),
    finances: filingCitation.nullable(),
    website: z.union([filingCitation, sourceFile]).nullable(),
  }),
});

const SEARCH_OUTPUT = z.object({
  query: z.string(),
  limit: z.number(),
  results: z.array(
    z.object({
      ein: z.string(),
      name: z.string(),
      city: z.string().nullable(),
      state: z.string().nullable(),
      is501c3: z.boolean().nullable(),
      deductible,
      revoked: z
        .boolean()
        .nullable()
        .describe(
          "True only when the exemption was revoked and has not been reinstated since, on the auto-revocation list or by a later Business Master File ruling month. False when it was not revoked or was later reinstated. Null until the auto-revocation list is imported.",
        ),
      revocationDate: z
        .string()
        .nullable()
        .describe(
          "YYYY-MM-DD from the auto-revocation list, or null when that list has no date. Still returned when the organization was later reinstated.",
        ),
      provenance: z.object({
        is501c3: sourceFile.nullable(),
        deductible: sourceFile.nullable(),
        revoked: sourceFile.nullable(),
        revocationDate: sourceFile.nullable(),
      }),
    }),
  ),
});

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
      outputSchema: LOOKUP_OUTPUT,
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
      outputSchema: SEARCH_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) =>
      toolResult(await searchAs({ query, limit }, caller), renderSearch),
  );
  return server;
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

type McpEnv = { Variables: { caller: Caller } };

/**
 * `POST /mcp`: stateless streamable HTTP. The credential is checked once per
 * HTTP request, before any MCP message is read, so a bad key is a 401 even
 * on the handshake; each tool call is then counted like a REST request.
 */
export function mcpHandlers(service: Service, now: () => Date) {
  const factory = createFactory<McpEnv>();
  return factory.createHandlers(
    // the MCP transport spec: servers MUST validate Origin; only a page served from this host may call it from a browser
    factory.createMiddleware(async (c, next) => {
      const crossOrigin = originValidationResponse(c.req.raw, [
        new URL(c.req.url).hostname,
      ]);
      if (crossOrigin !== undefined) return crossOrigin;
      await next();
    }),
    factory.createMiddleware(async (c, next) => {
      const caller = await authorizeAs({
        service,
        request: clientRequestOf(c.req.raw),
        now: now(),
      });
      if (!caller.ok) return refuse(c, caller.error);
      const limited = await limitKeylessMcpRequests(caller.value);
      if (!limited.ok) return refuse(c, limited.error);
      c.set("caller", caller.value);
      await next();
    }),
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () =>
        problem(
          413,
          "body_too_large",
          `An MCP request body is at most ${MAX_BODY_BYTES} bytes.`,
        ),
    }),
    async (c) => {
      const body = await c.req.text();
      const listen = listenRequestIn(body);
      if (listen !== undefined) return refuseListen(listen.id ?? null);

      const caller = c.get("caller");
      const { raw } = c.req;
      // the body is read: the SDK gets it back in a request of its own
      return createMcpHandler(() => nonprofitsServer(caller), {
        onerror: (error) => logFailure("mcp_error", error),
      }).fetch(
        new Request(raw.url, {
          method: raw.method,
          headers: raw.headers,
          body,
          signal: raw.signal,
        }),
      );
    },
  );
}
