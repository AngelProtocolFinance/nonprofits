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

A request with no `Authorization` header is served keyless: 5 requests per UTC day and 1 per minute per client IP (`CF-Connecting-IP`, stored only as an HMAC keyed by the `IP_HASH_SECRET` secret, never the raw IP). A key lifts those limits, sent as `Authorization: Bearer <key>`; a malformed, unknown or revoked key is a 401, never served keyless. Keys are issued and revoked through the Worker's admin endpoints, with `ADMIN_TOKEN` read from `.dev.vars`:

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
| `per_minute_limit_exceeded` | Past the per-minute limit. For default keys and keyless callers it is the `KEY_BURST_LIMITER` / `KEYLESS_BURST_LIMITER` Rate Limiting binding, approximate by design (per Cloudflare location, eventually consistent); `Retry-After: 60`. |
| `daily_quota_exceeded` | Past the caller's daily quota; `Retry-After` to the next UTC midnight. |
| `service_daily_limit_reached` | Default keys and keyless callers together are past `SERVICE_DAILY_LIMIT` (a var in `wrangler.jsonc`, 250,000 per UTC day); `Retry-After` to the next UTC midnight. |

`set-limit` whitelists a key with its own daily and per-minute limits, counted exactly per clock minute in D1, outside both the binding and the service-wide limit; `--default` puts it back. Usage lives in `key_usage`, one row per key or hashed IP per day plus the service's row (`*`), which imports never touch; a daily cron (`17 3 * * *`) deletes rows more than 7 days old.

Against a deployed Worker, set `NONPROFITS_URL` and `ADMIN_TOKEN` in the shell. `pnpm auth:generate` writes better-auth's schema for the current plugins to `.wrangler/auth-schema.sql`, the source for any new auth migration.

Rerun `pnpm types` after editing `wrangler.jsonc`.

## Import

Loads the IRS EO BMF (`eo1.csv` … `eo4.csv`) into the worker's D1, local by default:

```sh
pnpm --filter @nonprofits/worker db:migrate:local   # once, on a fresh local D1
pnpm --filter @nonprofits/import bmf                # or: bmf --remote
```

The job streams each file into one SQL load file (`load/bmf.load.sql`) and applies it with a single `wrangler d1 execute --file`, so a header that drifted from the expected layout, or fewer orgs than the floor, aborts before anything is loaded. Re-running replaces the BMF rows in place.
