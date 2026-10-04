# Deploy your own

This guide takes a fork of this repository to a running copy on your own Cloudflare account: the Worker serving REST and MCP on `workers.dev` (or your domain), three D1 databases holding the IRS data, a monthly GitHub Actions import that rebuilds them, and API keys you issue with the CLI.

Commands run from the repository root unless a step says `packages/worker`. Replace every `<placeholder>`.

## Before you start

- **Cloudflare account on Workers Paid** ($5 a month minimum). The Free plan can't hold the data: it caps a D1 database at 500 MB, an account at 5 GB and writes at 100,000 rows a day, and one build is about 2 GB per data database (about 4.2 GB across the three) and millions of rows. Workers Paid raises the cap to 10 GB per database and includes the first 5 GB of storage and 50 million rows written a month; usage past that is billed at [D1's rates](https://developers.cloudflare.com/d1/platform/pricing/).
- **GitHub account** with a fork of this repository.
- **Node 24** (`.nvmrc`), **pnpm** (the version in `package.json`'s `packageManager`; `corepack enable` provides it), `git` and `openssl`.

Secrets never go in the repository: it is public, and so is your fork. Each lives in one of three places:

| Secret | Where it lives | What it's for |
| --- | --- | --- |
| `BETTER_AUTH_SECRET`, `ADMIN_TOKEN`, `IP_HASH_SECRET`, `GITHUB_DISPATCH_TOKEN` | Worker secrets (`--secrets-file` on the first deploy, `wrangler secret put` after) | The deployed Worker; `.dev.vars.example` says what each one does |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions repository secrets | The monthly import |
| The same Worker secrets, with local values | `packages/worker/.dev.vars` (gitignored) | `wrangler dev` only; never uploaded |

## 1. Clone and install

```sh
git clone https://github.com/<your-github-user>/nonprofits.git
cd nonprofits
pnpm install --frozen-lockfile
```

## 2. Log in to Cloudflare

```sh
cd packages/worker
pnpm exec wrangler login
pnpm exec wrangler whoami    # note the Account ID: step 6 needs it
```

`pnpm exec wrangler` runs the version this repository pins. If `CLOUDFLARE_API_TOKEN` is set in your shell, wrangler uses it instead of your login, so leave it unset for these steps.

## 3. Create the three D1 databases

From `packages/worker`:

```sh
pnpm exec wrangler d1 create nonprofits-app
pnpm exec wrangler d1 create nonprofits-data-a
pnpm exec wrangler d1 create nonprofits-data-b
```

When wrangler asks whether to add each one to your configuration, answer no: the entries already exist, and step 4 fills them in. Copy each `database_id` it prints.

The migration and the import (steps 5 and 7) run before the first deploy, so the databases have to exist first. A binding left without a `database_id` is no error to `wrangler deploy`: it binds the database of that name, or creates one without asking.

## 4. Point the configuration at your account

Edit `packages/worker/wrangler.jsonc`:

1. **Database ids.** In each `d1_databases` entry, add the `database_id` from step 3 and a `preview_database_id` equal to the entry's `binding`:

   ```jsonc
   {
     "binding": "APP_DB",
     "database_name": "nonprofits-app",
     "database_id": "<nonprofits-app-id>",
     "preview_database_id": "APP_DB",
     "migrations_dir": "../db/migrations/app"
   },
   {
     "binding": "DATA_DB_A",
     "database_name": "nonprofits-data-a",
     "database_id": "<nonprofits-data-a-id>",
     "preview_database_id": "DATA_DB_A"
   },
   {
     "binding": "DATA_DB_B",
     "database_name": "nonprofits-data-b",
     "database_id": "<nonprofits-data-b-id>",
     "preview_database_id": "DATA_DB_B"
   }
   ```

   Local D1 state is keyed by `preview_database_id`, else `database_id`, else the binding. Without `preview_database_id`, adding the ids moves local state to new, empty databases, and every local request fails on missing tables until you migrate and seed again. The ids aren't secrets; commit them.

2. **`GITHUB_REPO`** in `vars`: set it to `<your-github-user>/nonprofits`. The freshness guard starts the import workflow in this repository; left as it is, it targets the upstream one, where your token has no access.

3. **Rate limiting namespace ids** (`1001` to `1004` under `ratelimits`). A `namespace_id` is shared across your whole account: another Worker with a binding on the same id shares its counters. Check your other Workers' configurations; if any uses one of these ids, change ours to integers nobody uses.

## 5. Create the app database's tables

From `packages/worker`:

```sh
pnpm exec wrangler d1 migrations apply APP_DB --remote
```

The data databases have no migrations: the import builds their tables.

## 6. Set up GitHub Actions in your fork

1. **Runner.** Both workflows run on `blacksmith-4vcpu-ubuntu-2404`, which needs the [Blacksmith](https://www.blacksmith.sh) GitHub app installed on your account. Without it, a job waits for a runner that never comes. Change `runs-on` to `ubuntu-latest` in `.github/workflows/import.yml` and `.github/workflows/ci.yml`. The import job's `timeout-minutes: 350` fits GitHub-hosted runners' 6-hour job limit.
2. **Commit and push** steps 4 and 6.1 to your fork's `main`. Scheduled workflows only run from the default branch, and the freshness guard dispatches the import on `main`.
3. **Enable Actions.** Workflows don't run in a fork until you enable them in its **Actions** tab. Scheduled workflows in a fork of a public repository start disabled: open **monthly import** in the Actions tab and enable it.
4. **Issues.** A failed import opens an issue in your fork. Check **Issues** is on under **Settings > General > Features**.
5. **Cloudflare API token.** In the Cloudflare dashboard, under **My Profile > API Tokens**, create a custom token with one permission, **Account > D1 > Edit**, for your account.
6. **Repository secrets.** Under **Settings > Secrets and variables > Actions**, add `CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID` (from step 2).

## 7. Load the IRS data

Until a first build is served, every `/v1` and MCP data request answers 503. Run the first build either way:

- **From GitHub:** in the Actions tab, open **monthly import**, select **Run workflow**, and leave both boxes unticked.
- **From your machine:** downloads about 10 GB, so it needs a steady connection for the whole run.

  ```sh
  export CLOUDFLARE_API_TOKEN=<your-d1-token>
  export CLOUDFLARE_ACCOUNT_ID=<your-account-id>
  pnpm --filter @nonprofits/import irs refresh --remote
  unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID    # step 8 deploys with your login, not this D1-only token
  ```

A first refresh that fails leaves nothing served and prints why. One that stops while a remote load file is importing keeps its claim on the slot and prints the `irs release --remote --build <id>` to run once D1's import has ended; until then, every refresh is refused. [Import](../README.md#import) in the README covers each step, the checks a build must pass and rollback.

## 8. Deploy the Worker

The first deploy uploads the secrets with the code: the Worker requires all four (`secrets.required`), and `wrangler secret put` can't set a secret on a Worker that doesn't exist yet. From `packages/worker`, write them to a gitignored file:

```sh
{
  echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"
  echo "ADMIN_TOKEN=$(openssl rand -hex 32)"
  echo "IP_HASH_SECRET=$(openssl rand -hex 32)"
  echo "GITHUB_DISPATCH_TOKEN=<your-github-token>"
} > .env.production
git check-ignore .env.production    # prints the path when git ignores it; stop if it prints nothing
```

`GITHUB_DISPATCH_TOKEN` is optional. With it, the Worker's daily cron restarts the import when the served data is more than 35 days old, which covers GitHub disabling the schedule after 60 days without activity in a public repository (see [Freshness guard](../README.md#freshness-guard)). Create a fine-grained personal access token with access to your fork only and the **Actions** repository permission set to read and write. To go without, write `GITHUB_DISPATCH_TOKEN=replace-with-a-fine-grained-github-token` instead: the cron then logs `token_unset` and does nothing. The token expires on the date you choose; after that, the cron's dispatch fails until you set a new one.

Then deploy:

```sh
pnpm exec wrangler deploy --secrets-file .env.production
```

On an account with no `workers.dev` subdomain yet, wrangler asks you to register one. The Worker is served at `https://nonprofits.<your-subdomain>.workers.dev`.

Keep `ADMIN_TOKEN` somewhere safe: the key CLI needs it, and nothing shows a secret's value once set. Change a secret later from `packages/worker` with `pnpm exec wrangler secret put <NAME>`, which deploys at once. A later `wrangler deploy` keeps the secrets already set.

## 9. Issue an API key

The CLI calls the Worker's admin endpoints with `ADMIN_TOKEN`, over `https://` only. From the repository root:

```sh
export NONPROFITS_URL=https://nonprofits.<your-subdomain>.workers.dev
export ADMIN_TOKEN="$(grep '^ADMIN_TOKEN=' packages/worker/.env.production | cut -d= -f2-)"
pnpm --filter @nonprofits/cli keys create --email <owner-email> --name <key-name>
```

The key is printed once. [Worker, locally](../README.md#worker-locally) in the README lists the other `keys` commands (`list`, `revoke`, `set-limit`) and the limits a key gets.

## 10. Check it answers

The American Red Cross, EIN 530196605:

```sh
curl -H "Authorization: Bearer <your-key>" https://nonprofits.<your-subdomain>.workers.dev/v1/orgs/530196605
curl https://nonprofits.<your-subdomain>.workers.dev/v1/orgs/530196605    # keyless
```

Both answer with `AMERICAN NATIONAL RED CROSS`. The keyless tier allows 1 request a minute and 5 a UTC day per client, so a second keyless request inside a minute is a 429. A 503 means no build is served yet: check the import from step 7.

To connect an MCP client, see [MCP](../README.md#mcp) in the README, with `<worker-url>` as your Worker's URL.

## 11. Add a custom domain (optional)

Repeated searches are cached for up to an hour, but the Workers cache only stores on a custom domain: on `workers.dev` every search reads D1. With a domain on a zone in your Cloudflare account, add to `packages/worker/wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "<api.your-domain.example>", "custom_domain": true }],
"workers_dev": true
```

Then `pnpm exec wrangler deploy` from `packages/worker`. Adding `routes` without `"workers_dev": true` turns the `workers.dev` URL off on that deploy, so drop that line only once nothing calls the old URL. Point `NONPROFITS_URL` at the new domain.

## Keeping it running

- The import runs at 06:17 UTC on the 3rd of each month. [Monthly import](../README.md#monthly-import) in the README covers its switches (rollback, a dry run) and what a failed run leaves.
- When you sync your fork with upstream, keep your `wrangler.jsonc` ids and `GITHUB_REPO` and your workflows' `runs-on` through any conflict there.
