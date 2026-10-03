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
cp .dev.vars.example .dev.vars   # then fill both secrets: openssl rand -base64 32
pnpm db:migrate:local
pnpm db:seed:local
pnpm db:search-index:local
pnpm dev
```

`/v1/search` reads a full-text index that migrations create empty and every load rebuilds. After migrating or seeding a local D1 that already holds orgs, rebuild it with `pnpm db:search-index:local`.

Every lookup needs an API key, sent as `Authorization: Bearer <key>`. Keys are issued and revoked through the Worker's admin endpoints, with `ADMIN_TOKEN` read from `.dev.vars`:

```sh
pnpm --filter @nonprofits/cli keys create --email <owner-email> [--name <name>]   # prints the key once
curl -H "Authorization: Bearer <key>" http://localhost:8787/v1/orgs/530196605
pnpm --filter @nonprofits/cli keys revoke <key-id>
```

Against a deployed Worker, set `NONPROFITS_URL` and `ADMIN_TOKEN` in the shell. `pnpm auth:generate` writes better-auth's schema for the current plugins to `.wrangler/auth-schema.sql`, the source for any new auth migration.

Rerun `pnpm types` after editing `wrangler.jsonc`.

## Import

Loads the IRS EO BMF (`eo1.csv` … `eo4.csv`) into the worker's D1, local by default:

```sh
pnpm --filter @nonprofits/worker db:migrate:local   # once, on a fresh local D1
pnpm --filter @nonprofits/import bmf                # or: bmf --remote
```

The job streams each file into one SQL load file (`load/bmf.load.sql`) and applies it with a single `wrangler d1 execute --file`, so a header that drifted from the expected layout, or fewer orgs than the floor, aborts before anything is loaded. Re-running replaces the BMF rows in place.
