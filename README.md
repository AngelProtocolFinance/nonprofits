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
pnpm db:migrate:local
pnpm db:seed:local
pnpm dev            # GET http://localhost:8787/v1/orgs/530196605
```

Rerun `pnpm types` after editing `wrangler.jsonc`.

## Import

Loads the IRS EO BMF (`eo1.csv` … `eo4.csv`) into the worker's D1, local by default:

```sh
pnpm --filter @nonprofits/worker db:migrate:local   # once, on a fresh local D1
pnpm --filter @nonprofits/import bmf                # or: bmf --remote
```

The job streams each file into one SQL load file (`load/bmf.load.sql`) and applies it with a single `wrangler d1 execute --file`, so a header that drifted from the expected layout, or fewer orgs than the floor, aborts before anything is loaded. Re-running replaces the BMF rows in place.
