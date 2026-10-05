# Contributing

Setup for working on the service behind [nonprofits.better.giving](https://nonprofits.better.giving). Using the API is in the [README](README.md).

## Prerequisites

- Node 24 (`.nvmrc`)
- pnpm, the version in `package.json`'s `packageManager`: `corepack enable` provides it

```sh
pnpm install --frozen-lockfile
```

## Layout

- `packages/core`: lookup and search, shared by REST and MCP
- `packages/db`: app database migrations, the data database schema and search index
- `packages/api`: the Hono app on Vercel: REST, MCP, admin endpoints, daily cron
- `packages/import`: the Node job that builds each month's IRS data and publishes it to Turso
- `packages/cli`: API key admin

Dependency versions live in the `catalog` in `pnpm-workspace.yaml`.

## Checks

```sh
pnpm check
```

Biome, every package's typecheck, then the Vitest suite; CI runs the same. Before a commit, `pnpm exec biome check .` and `pnpm typecheck` are the quick pair. `pnpm format <paths>` formats only the paths given. [TESTING.md](TESTING.md) covers how the suite is laid out.

## Run the API

```sh
pnpm --filter @nonprofits/api dev                    # http://localhost:8787 (PORT to change)
curl http://localhost:8787/v1/orgs/530196605
```

With nothing configured it serves the eight orgs in `packages/db/fixtures/seed.sql` from temporary databases, deleted on exit.

To try MCP against it:

```sh
npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp --method tools/list
```

## API keys, locally

The admin endpoints stay off until `packages/api/.env.local` (gitignored; the CLI reads it too) sets `ADMIN_TOKEN` and `BETTER_AUTH_SECRET`. Write it, restart the dev server, then:

```sh
printf 'ADMIN_TOKEN=%s\nBETTER_AUTH_SECRET=%s\n' "$(openssl rand -base64 32)" "$(openssl rand -base64 32)" > packages/api/.env.local
pnpm --filter @nonprofits/cli keys create --email <owner-email> [--name <name>]   # prints the key once
curl -H "Authorization: Bearer <key>" http://localhost:8787/v1/orgs/530196605
pnpm --filter @nonprofits/cli keys list
pnpm --filter @nonprofits/cli keys set-limit <key-id> --daily 500 --per-minute 60
pnpm --filter @nonprofits/cli keys revoke <key-id>
```

`packages/api/.env.example` lists every variable the api reads. Against the deployed api, set `NONPROFITS_URL` and `ADMIN_TOKEN` in the shell; they win over `.env.local`.

## Real data, locally

```sh
pnpm --filter @nonprofits/db migrate                                         # once: .turso/app.db
pnpm --filter @nonprofits/import irs build --efile-batch 2026_TEOS_XML_03A   # a partial file, quick
pnpm --filter @nonprofits/import irs refresh                                 # the whole month: ~10 GB of downloads
pnpm --filter @nonprofits/api dev                                            # serves what refresh published
```

With `TURSO_APP_DB_URL` unset, `refresh` publishes to local files under `.turso/`, and the dev server serves them. `irs build` builds `data/nonprofits.db` without publishing.

## Monthly import

`.github/workflows/import.yml` runs `irs refresh` against Turso on the 3rd of each month, and can be run by hand from the Actions tab. Its **force_verify_failure** switch is a dry run: it builds and checks everything, then publishes nothing. A failed run opens a "Monthly IRS import failed" issue.

## Deploy your own

From a fork, on your own Vercel (Pro) and Turso accounts: [docs/deploy.md](docs/deploy.md).

## License

MIT, see [LICENSE](LICENSE).
