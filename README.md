# nonprofits

Look up IRS exempt organizations by EIN, over REST and MCP.

## Layout

pnpm workspace, one package per deliverable plus shared code:

- `packages/core` — response types and handlers shared by REST and MCP
- `packages/db` — app DB migrations, the data DBs' schema and generation SQL (reset, seal, flip), and table/column constants shared by worker and import
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

From `packages/worker`, against local D1 seeded with fixture rows:

```sh
cp .dev.vars.example .dev.vars   # then fill each secret: openssl rand -base64 32
pnpm db:migrate:local            # APP_DB: auth, key limits and usage, the data pointer (on slot a, empty)
pnpm db:reset:local b            # claim slot b and rebuild its data tables, empty
pnpm db:seed:local b
pnpm db:search-index:local b
pnpm db:seal:local b             # read-only from here until its next reset
pnpm db:flip:local b             # serve it
pnpm dev
```

The Worker reads IRS data from one of two data databases, `DATA_DB_A` or `DATA_DB_B` (slots `a` and `b`), whichever the one-row `data_generation` table in `APP_DB` names. Keys and usage live in `APP_DB`, so resetting a data slot never touches them. A data DB has no migrations: `db:reset:local <slot>` claims the slot in `data_generation` and drops and rebuilds its tables empty. The served slot can't be claimed, so a build always goes into the other one, and neither can the slot a flip left, for 60 s, while Workers may still serve it. A local reset's claim lapses after 10 minutes if the build is abandoned. `db:seal:local <slot>` marks the build complete, after which the slot refuses every write until its next reset. `db:flip:local <slot>` serves a sealed slot, and flipping back to the previous slot is a rollback, for as long as nothing has reset it. Each Worker isolate rereads the pointer at most every 30 s, and it switches only to a slot whose own `data_meta` is sealed for the build the pointer names; until then it keeps serving the slot it had. A flip therefore reaches every request within 30 s, and each lookup or search is answered whole from one slot or the other.

`/v1/search` reads a full-text index that a reset creates empty and `irs refresh` rebuilds once, after its last load; a local load run rebuilds it too. After seeding a slot that holds orgs, rebuild its index with `pnpm db:search-index:local <slot>` before sealing it.

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

`irs refresh` builds a whole new generation of the IRS data into the data DB the Worker isn't serving, checks it, and serves it; `irs rollback` serves the previous one again. Local by default, `--remote` for the deployed databases, `--persist-to <dir>` for local D1 state outside wrangler's default:

```sh
pnpm --filter @nonprofits/import irs refresh             # every source: ~10 GB of downloads, about an hour
pnpm --filter @nonprofits/import irs refresh --efile-batch 2026_TEOS_XML_03A   # local only: e-file from these batches alone
pnpm --filter @nonprofits/import irs rollback
pnpm --filter @nonprofits/import irs release [--build <id>]   # clear a claim a dead build left
```

A refresh logs one line per step, with its time:

1. Wait until the last flip is 60 s old: Worker isolates cache the pointer for 30 s, so the slot a flip left may still be served until then, and `APP_DB` refuses a claim on it sooner.
2. Claim the slot not served in `APP_DB`'s `data_generation`; refused while another build's claim runs.
3. Reset that slot's database empty (`resetGenerationSql`), its `data_meta` saying `building`.
4. Load bmf, pub78, revocation, epostcard and efile (the full run), in that order. Each streams into its own SQL file under `load/` and is applied with one `wrangler d1 execute --file`, holding its own floors first: a drifted layout or a short count aborts before the apply.
5. Rebuild the search index, once.
6. Verify, one query per check, each logged with its time:
   - `data_meta` names this slot and build;
   - each table holds at least its floor: 2,948,000 orgs (90% of the October 2026 build), 684,000 filings (90% of the 760,592 latest filings a full run selects) and 750,000 programs (80% of ~939,500, extrapolated from batch 2026_TEOS_XML_03A). These are what a first build, with nothing served to compare, is held to;
   - orgs, filings and programs each within ±10% of the served generation, skipped while none is served yet;
   - Red Cross (530196605) present with a mission;
   - one search index row per named org;
   - no row without an EIN.
7. Seal the slot (read-only until its next reset), then flip the pointer to it, a compare-and-set that fails if the pointer moved during the run. Each Worker isolate picks it up within 30 s. A flip whose answer is lost is read back from the pointer before it is reported either way.

Any failure exits 1 with the pointer unchanged and the claim released; the Worker keeps serving the previous generation. The slot stays as the failure left it, for inspection until the next refresh resets it: `building` when the run stopped before the seal, or sealed `complete` but never served when the flip itself failed. `APP_DB` only ever gets `--command`: `--file` goes through D1's import API, which blocks its database for the whole import. Each wrangler command is killed after 10 min (a query) or 2 h (a load file). SIGINT or SIGTERM kills the running command, releases the claim, prints what the pointer serves, and exits 130 or 143.

`--efile-batch` builds a partial generation: it skips the filings and programs floors, and passes the ±10% check only against a served build made from the same batches. `refresh` refuses it with `--remote`.

`irs rollback` flips back to the other slot while it holds a complete generation that was served before: a build sealed after the pointer last moved never was, and rollback refuses it. Like a refresh, it waits until the last flip is 60 s old before claiming. Once a refresh has reset that slot, rollback exits 1 and prints the `wrangler d1 time-travel restore` for that slot's database, which brings back the generation from before the reset; run `irs rollback` again once restored.

A build that died without releasing its claim (a killed runner) blocks every refresh until its lease runs out. `irs release` clears the claim and prints whose it was; `--build <id>` clears only that build's, and exits 1 when that build holds none. Release only a build that is no longer running: a running one would lose its flip while another build reset its slot.

Exit codes: 0 done, 1 failed, 2 usage, 130/143 interrupted.

One source at a time is for development, local only, into a slot reset for it, never the one served; a sealed slot refuses every write. The search index is rebuilt after the run:

```sh
pnpm --filter @nonprofits/worker db:reset:local b       # claims slot b (it must not be the one served) and empties it
pnpm --filter @nonprofits/import irs all                # bmf, pub78, revocation, epostcard into the slot not served; --slot a|b to name one
pnpm --filter @nonprofits/import irs efile              # 990 e-file XML: the full 3-year run
pnpm --filter @nonprofits/import irs efile --batch 2026_TEOS_XML_03A   # one batch; every other stored filing kept
pnpm --filter @nonprofits/worker db:seal:local b        # then db:flip:local b to serve it
```

`all` leaves out `efile`, which runs only when named. It reads the 990 e-file index of the three latest release years (the year before, when this year's index isn't published yet), keeps each EIN's latest filing (latest tax period, then latest received, amendments included), and parses those returns out of the batch zips, one zip on disk at a time under `data/efile/`: a Form 990's mission, activity summary, website, top 3 programs and finances (total revenue, expenses, assets at year end); a 990-EZ's primary exempt purpose as its mission, website, top 3 programs and finances; a 990-PF's website and finances. A mission that only points to Schedule O is stored as null and flagged `mission_on_schedule_o`. Index rows of other return types (990-T, or one the IRS adds) are counted by type in the run's output. A return whose EIN, form type, an amount or its tax year can't be read is rejected and skipped, keeping that EIN's stored filing; more than 1% rejected, or a form's returns (run-wide, or in a returnVersion with 200+ of them) under its yield floors — mission and revenue for the 990, mission and all three finances for the 990-EZ, all three finances for the 990-PF — aborts before anything is loaded, as does a full run that selects none of a form. A full run deletes the filings it didn't write and the orgs left with no fact and no filing; a `--batch` run deletes nothing.
