# nonprofits

Look up IRS exempt organizations by EIN, over REST and MCP.

## Layout

pnpm workspace, one package per deliverable plus shared code:

- `packages/core` — response types and handlers shared by REST and MCP
- `packages/db` — D1 migrations, table/column constants and staging-table DDL shared by worker and import
- `packages/worker` — Cloudflare Worker serving REST + MCP
- `packages/import` — Node job that ingests IRS data
- `packages/cli` — API key admin

Node 24 (`.nvmrc`), pnpm pinned via `packageManager`. Dependency versions live in the `catalog` in `pnpm-workspace.yaml`.

## Gate

```sh
pnpm check
```

Runs Biome, `tsc --noEmit` per package, and Vitest, sequentially. CI runs the same command. `pnpm format <paths>` formats only the paths given.

## Worker, locally

From `packages/worker`, against a local D1 seeded with fixture rows:

```sh
cp .dev.vars.example .dev.vars   # then fill each secret: openssl rand -base64 32
pnpm db:migrate:local
pnpm db:seed:local
pnpm db:search-index:local
pnpm dev
```

`/v1/search` reads a full-text index that migrations create empty and every load rebuilds. After migrating or seeding a local D1 that already holds orgs, rebuild it with `pnpm db:search-index:local`.

A request with no `Authorization` header is served keyless: 5 requests per UTC day and 1 per minute per client. A client is its IP from `CF-Connecting-IP` (an IPv6 address counts as its /64), plus the `CF-Worker` zone when another zone's Worker sent the request. It is stored only as an HMAC keyed by the `IP_HASH_SECRET` secret, never the raw IP. Worker-hosted integrators should use a key: requests from other zones' Workers may all reach us from one Cloudflare IP. A key lifts the keyless limits, sent as `Authorization: Bearer <key>`; a malformed, unknown or revoked key is a 401, never served keyless. Keys are issued and revoked through the Worker's admin endpoints, with `ADMIN_TOKEN` read from `.dev.vars`:

```sh
pnpm --filter @nonprofits/cli keys create --email <owner-email> [--name <name>]   # prints the key once
curl http://localhost:8787/v1/orgs/530196605                                       # keyless
curl -H "Authorization: Bearer <key>" http://localhost:8787/v1/orgs/530196605
pnpm --filter @nonprofits/cli keys revoke <key-id>
pnpm --filter @nonprofits/cli keys list                 # status, tier, limits, today's usage; never a key
pnpm --filter @nonprofits/cli keys set-limit <key-id> --daily 500 --per-minute 60
pnpm --filter @nonprofits/cli keys set-limit <key-id> --default
```

Each key gets 50 requests per UTC day and 10 per minute; lookups and searches count alike, and a refused request is not counted. Every 429 is problem details with `Retry-After`:

| `code` | When |
| --- | --- |
| `per_minute_limit_exceeded` | Past a per-minute limit. For default keys and keyless callers it is the `KEY_BURST_LIMITER` / `KEYLESS_BURST_LIMITER` Rate Limiting binding, approximate by design (per Cloudflare location, eventually consistent); `Retry-After: 60`. Any request carrying a key, valid or not, also meets `KEYED_REQUEST_LIMITER`: 600 a minute per client, before the key is read. |
| `daily_quota_exceeded` | Past the caller's daily quota; `Retry-After` to the next UTC midnight. |
| `service_daily_limit_reached` | A tier is past its service-wide daily limit, a var in `wrangler.jsonc`: `SERVICE_KEY_DAILY_LIMIT` (50,000) for default keys, `SERVICE_KEYLESS_DAILY_LIMIT` (200,000) for keyless callers, so neither tier can use up the other's. `Retry-After` to the next UTC midnight. A var that isn't a positive integer refuses that tier with 503 until fixed. |

`set-limit` whitelists a key with its own daily and per-minute limits, counted exactly per clock minute in D1, outside the burst bindings and the service-wide limits; `--default` puts it back. A per-minute limit above 600 can't be reached from one client, since `KEYED_REQUEST_LIMITER` caps it first. Usage lives in `key_usage`, one row per key or hashed client per day plus each tier's service row (`*:key`, `*:keyless`), which imports never touch; a daily cron (`17 3 * * *`) deletes rows more than 7 days old.

Against a deployed Worker, set `NONPROFITS_URL` and `ADMIN_TOKEN` in the shell. `pnpm auth:generate` writes better-auth's schema for the current plugins to `.wrangler/auth-schema.sql`, the source for any new auth migration.

Rerun `pnpm types` after editing `wrangler.jsonc`.

## MCP

The same Worker serves `/mcp` (streamable HTTP, stateless) with two tools: `lookup_nonprofit` (`ein`) and `search_nonprofits` (`query`, optional `limit`). Each answers with the REST JSON as structured content, and as text after a short rendering. A REST error comes back as a tool error (`isError: true`) carrying the REST problem body, plus `retryAfterSeconds` on a 429. Connect Claude Code:

```sh
claude mcp add --transport http nonprofits <worker-url>/mcp --header "Authorization: Bearer <key>"
claude mcp add --transport http nonprofits <worker-url>/mcp   # keyless
```

Keyless `/mcp` is limited per IP address, so it suits a client running on one machine. A hosted connector (claude.ai, ChatGPT and the like) calls from its provider's servers, so all of its users would share one IP's keyless limits: it isn't a supported keyless client. Configure it with a key instead (ask the operator for one).

Auth and limits are REST's: a malformed, unknown or revoked key is the same 401 problem before any MCP message is read, no `Authorization` header is the keyless tier, and each tool call counts as one request on the same counters as REST. Protocol messages (the handshake, tool listings) count toward no quota, but HTTP requests are capped per client whatever messages each carries: those carrying a key by `KEYED_REQUEST_LIMITER`, keyless ones by `KEYLESS_MCP_LIMITER` (60 HTTP requests a minute, then `per_minute_limit_exceeded`). A batch of tool calls in one request counts each call. `subscriptions/listen` is refused: the tools never change.

A 401 carries a `Bearer` challenge, which some MCP clients show as an OAuth or login prompt. Here it always means the key is wrong: check it was copied whole, or ask the operator for a new one.

To try it against `pnpm dev`:

```sh
npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp --method tools/list
```

## Import

Loads the IRS EO BMF (`eo1.csv` … `eo4.csv`) into the worker's D1, local by default:

```sh
pnpm --filter @nonprofits/worker db:migrate:local   # once, on a fresh local D1
pnpm --filter @nonprofits/import bmf                # or: bmf --remote
```

The job streams each file into one SQL load file (`load/bmf.load.sql`) and applies it with a single `wrangler d1 execute --file`, so a header that drifted from the expected layout, or fewer orgs than the floor, aborts before anything is loaded. Re-running replaces the BMF rows in place.

The other sources go through `irs <source>`, each as its own load:

```sh
pnpm --filter @nonprofits/import irs all                # bmf, pub78, revocation, epostcard
pnpm --filter @nonprofits/import irs efile              # 990 e-file XML: the full 3-year run, ~10 GB and about an hour
pnpm --filter @nonprofits/import irs efile --batch 2026_TEOS_XML_03A   # one batch; every other stored filing kept
```

`all` leaves out `efile`, which runs only when named. It reads the 990 e-file index of the three latest release years (the year before, when this year's index isn't published yet), keeps each EIN's latest filing (latest tax period, then latest received, amendments included), and parses those returns out of the batch zips, one zip on disk at a time under `data/efile/`: a Form 990's mission, activity summary, website, top 3 programs and finances (total revenue, expenses, assets at year end); a 990-EZ's primary exempt purpose as its mission, website, top 3 programs and finances; a 990-PF's finances only. Index rows of other return types (990-T, or one the IRS adds) are counted by type in the run's output. A return whose EIN, form type, an amount or its tax year can't be read is rejected and skipped, keeping that EIN's stored filing; more than 1% rejected, or a form's returns (run-wide, or in a returnVersion with 200+ of them) under its yield floors — mission and revenue for the 990, mission and all three finances for the 990-EZ, all three finances for the 990-PF — aborts before anything is loaded. A full run deletes the filings it didn't write and the orgs left with no fact and no filing; a `--batch` run deletes nothing.
