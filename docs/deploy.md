# Deploy your own

This guide takes a fork of this repository to a running copy on your own Vercel and Turso accounts: the api serving REST and MCP on a `vercel.app` address, Turso databases holding the keys and the IRS data, a monthly GitHub Actions import that rebuilds the data, and API keys you issue with the CLI.

Commands run from the repository root. Replace every `<placeholder>`. Steps 2 to 12 act on your Turso, GitHub and Vercel accounts; nothing in this repository runs them for you.

## Before you start

- **Vercel account on Pro** ($20 a month), which this guide was written against. The api runs as one Vercel Function in US East (the region in `packages/api/vercel.json`), a daily Vercel Cron job keeps it tidy, and four Vercel Firewall rate-limit rules enforce its per-minute limits. The Firewall bills each rate-limit check past the plan's included usage (about $0.50 per million; at most two checks a request): see [WAF rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting).
- **Turso account on the free plan.** It holds the data with little room to spare: [The free Turso plan](#the-free-turso-plan) below says what it allows and what happens at its limits.
- **GitHub account** with a fork of this repository.
- **Node 24** (`.nvmrc`), **pnpm** (the version in `package.json`'s `packageManager`; `corepack enable` provides it), `git`, `openssl`, and the [Turso CLI](https://docs.turso.tech/cli/installation). The [GitHub CLI](https://cli.github.com) is optional (step 5 shows its commands beside the dashboard's), and step 10's cron check uses the [Vercel CLI](https://vercel.com/docs/cli).

Secrets never go in the repository: it is public, and so is your fork. Each lives in one of three places:

| Secret | Where it lives | What it's for |
| --- | --- | --- |
| `TURSO_APP_DB_URL`, `TURSO_APP_DB_TOKEN`, `TURSO_DATA_DB_TOKEN`, `IP_HASH_SECRET`, `BETTER_AUTH_SECRET`, `ADMIN_TOKEN`, `CRON_SECRET`, `GITHUB_DISPATCH_TOKEN` | Vercel environment variables, Production only | The deployed api; `packages/api/.env.example` says what each one does |
| `TURSO_APP_DB_URL`, `TURSO_APP_DB_TOKEN`, `TURSO_PLATFORM_TOKEN`, `TURSO_ORG`, `TURSO_GROUP` | GitHub Actions repository secrets | The monthly import |
| `ADMIN_TOKEN` and `BETTER_AUTH_SECRET`, with local values | `packages/api/.env.local` (gitignored) | The local api and the key CLI only; never uploaded |

## 1. Clone and install

```sh
git clone https://github.com/<your-github-user>/nonprofits.git
cd nonprofits
pnpm install --frozen-lockfile
```

## 2. Create the Turso group and the app database

```sh
turso auth signup                 # or `turso auth login` with an account already
turso org list                    # note your organization's slug: steps 4 and 5 need it
turso group create nonprofits --location aws-us-east-1
turso db create nonprofits-app --group nonprofits
```

The group holds every database the api reads: the app database (keys, usage counters, and the pointer naming the data database served) and one data database per monthly build, which the import creates as `nonprofits-data-<build id>`. `aws-us-east-1` (Virginia) sits beside the api's Vercel region in US East, and every query is a round trip between them. `turso db locations` lists the codes if that one has moved.

Create the databases with the CLI as shown, so they run Turso's libSQL engine: search needs its full-text index (FTS5).

## 3. Create the app database's tables

```sh
turso db show nonprofits-app --url
turso db tokens create nonprofits-app --expiration never
export TURSO_APP_DB_URL=<the-libsql-url> TURSO_APP_DB_TOKEN=<the-token>
pnpm --filter @nonprofits/db migrate
```

`turso db tokens create` makes a read-write token for that one database; `--expiration never` keeps the deployed api from losing it on a date. The migrate command prints `applied <file>` for each migration in `packages/db/migrations/app/`, and `app database is current` when run again. The data databases have no migrations: the import builds their tables.

Keep this shell open: steps 5, 6 and 8 need both values again.

## 4. Mint the other two Turso tokens

```sh
turso group tokens create nonprofits --read-only --expiration never
turso auth api-tokens mint nonprofits-import --org <org> --group nonprofits \
  --scope db:create --scope db:mint-token --scope db:delete
```

Copy each token as it prints; nothing shows it again.

- The **group read-only token** is the api's `TURSO_DATA_DB_TOKEN`. It reads every database in the group, so next month's data database needs no new token.
- The **Platform API token** is the import's `TURSO_PLATFORM_TOKEN`. It may create, mint tokens for and delete databases in this group only, which is what a refresh does.

## 5. Set up GitHub Actions in your fork

1. **Runner.** Both workflows run on `blacksmith-4vcpu-ubuntu-2404`, which needs the [Blacksmith](https://www.blacksmith.sh) GitHub app installed on your account. Without it, a job waits for a runner that never comes. Change `runs-on` to `ubuntu-latest` in `.github/workflows/import.yml` and `.github/workflows/ci.yml`. The import job's `timeout-minutes: 350` fits GitHub-hosted runners' 6-hour job limit.
2. **Commit and push** step 5.1 to your fork's `main`. Scheduled workflows only run from the default branch, and the daily cron dispatches the import on `main`.
3. **Enable Actions.** Workflows don't run in a fork until you enable them in its **Actions** tab. Scheduled workflows in a fork of a public repository start disabled: open **monthly import** in the Actions tab and enable it.
4. **Issues.** A failed import opens an issue in your fork. Check **Issues** is on under **Settings > General > Features**.
5. **Repository secrets.** Under **Settings > Secrets and variables > Actions**, add `TURSO_APP_DB_URL` (the app database's `libsql://` URL), `TURSO_APP_DB_TOKEN` (its read-write token), `TURSO_PLATFORM_TOKEN` (step 4's Platform API token), `TURSO_ORG` (your organization's slug) and `TURSO_GROUP` (`nonprofits`). With the GitHub CLI, from the shell of step 3:

   ```sh
   gh secret set TURSO_APP_DB_URL --body "$TURSO_APP_DB_URL"
   printf '%s' "$TURSO_APP_DB_TOKEN" | gh secret set TURSO_APP_DB_TOKEN
   gh secret set TURSO_PLATFORM_TOKEN    # prompts for the value
   gh secret set TURSO_ORG --body <org>
   gh secret set TURSO_GROUP --body nonprofits
   ```

## 6. Load the IRS data

Until a first build is served, every `/v1` and MCP data request answers 503 `data_unavailable`. Run the first build either way:

- **From GitHub:** in the Actions tab, open **monthly import**, select **Run workflow**, and leave **force_verify_failure** unticked.
- **From your machine:** downloads about 10 GB, so it needs a steady connection for the whole run. In the shell of step 3:

  ```sh
  export TURSO_PLATFORM_TOKEN=<the-platform-token> TURSO_ORG=<org> TURSO_GROUP=nonprofits
  pnpm --filter @nonprofits/import irs refresh
  unset TURSO_PLATFORM_TOKEN TURSO_ORG TURSO_GROUP
  ```

A run that succeeds leaves one `nonprofits-data-<build id>` database in `turso db list` and the pointer naming it. A first refresh that fails, or is stopped, leaves nothing served, deletes the database it was making and prints why. [Import](../README.md#import) in the README covers each step and the checks a build must pass.

## 7. Create the Vercel project

In the Vercel dashboard, **Add New > Project**, and import your fork. Before **Deploy**:

- **Root Directory**: select **Edit** and choose `packages/api`. It is a project setting, which `vercel.json` can't set. The project's build still reads the workspace packages beside it, so leave the setting that includes files outside the root directory on.
- **Framework, build and output**: leave them as detected. `packages/api/vercel.json` sets them, with the region and the cron job.
- **Environment Variables**: leave them for step 8, which scopes them to Production.

Then deploy. The build bundles the api, and the deployment answers every request with a 503 `server_misconfigured` naming the variables it still needs: that is the next step. Your production address is on the project's overview, `https://<your-project>.vercel.app`.

## 8. Set the environment variables

Under the project's **Settings > Environment Variables**, add each of these with only **Production** ticked. A preview deployment then has none of them and answers 503 `server_misconfigured`, on purpose: with them, every preview of a branch would write your production usage counters and could mint keys.

| Name | Value |
| --- | --- |
| `TURSO_APP_DB_URL` | `turso db show nonprofits-app --url` |
| `TURSO_APP_DB_TOKEN` | the app database's read-write token from step 3 |
| `TURSO_DATA_DB_TOKEN` | the group read-only token from step 4 |
| `IP_HASH_SECRET` | `openssl rand -base64 32` |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `ADMIN_TOKEN` | `openssl rand -base64 32` |
| `CRON_SECRET` | `openssl rand -base64 32` |

Each secret needs at least 32 characters; a shorter one, or one still starting with the `.env.example` placeholder's `replace-with-`, counts as unset. Keep `ADMIN_TOKEN` somewhere safe: the key CLI needs it. Vercel sends `CRON_SECRET` with each cron request, and the cron route refuses any request without it.

Optional, each leaving the default when unset:

- **`GITHUB_DISPATCH_TOKEN`**: with it, the daily cron restarts the import when the served data is more than 35 days old, which covers GitHub disabling the schedule after 60 days without activity in a public repository (see [Freshness guard](../README.md#freshness-guard)). Create a fine-grained personal access token with access to your fork only and the **Actions** repository permission set to read and write. Without it the cron logs `token_unset` and starts nothing. The token expires on the date you choose; after that, the cron's dispatch fails until you set a new one.
- **`GITHUB_REPO`**: `owner/repo` whose import the cron starts. It defaults to the GitHub repository Vercel deployed from, your fork; set it only when that isn't so.
- **`STALE_AFTER_DAYS`** and **`REDISPATCH_AFTER_HOURS`**: the freshness guard's 35 days and 72 hours.
- **`SERVICE_KEYLESS_DAILY_LIMIT`** and **`SERVICE_KEY_DAILY_LIMIT`**: the service-wide daily ceilings, below.
- **`RATE_LIMIT_SECRET`**: salts the keys the api sends to the Firewall's rate-limit rules.

## 9. Add the per-minute limits

The api counts its per-minute limits in four Vercel Firewall rules, so a refused request never reaches Turso. Until all four are published, every metered request answers 503 `auth_unavailable`: the api refuses rather than serve a request it can't count.

In the project, open **Firewall**, select **Configure**, then **+ New Rule**, once for each row:

| Rate limit ID | Requests per 60 s | What it limits |
| --- | --- | --- |
| `keyless-burst` | 1 | Each keyless client |
| `key-burst` | 10 | Each default-tier key |
| `keyed-requests` | 600 | Each client sending any key, before the key is read |
| `keyless-mcp-requests` | 60 | Each keyless client's HTTP requests to `/mcp` |

For each: give it a name, choose `@vercel/firewall` for the first **If** condition, enter the **Rate limit ID**, set **Rate Limit** to a **Fixed Window** of 60 seconds with the request limit from the table, keep the default **Then** action (429), and select **Save Rule**. Then **Review Changes** and **Publish**. The IDs must match exactly: the api names them in `packages/api/src/firewall-limiter.ts`, and the limits are the ones `packages/api/src/quota.ts` refuses with.

## 10. Deploy

Environment variables reach a deployment only when it is built, so redeploy: in **Deployments**, open the latest production deployment's menu and select **Redeploy**. A later push to `main` deploys on its own.

Then check the daily cron, which prunes old usage rows and runs the freshness guard, by running it now with the Vercel CLI from the repository root:

```sh
vercel link
vercel crons run /cron/daily
```

Its log line in the project's **Logs** reads `data_fresh` once step 6 has served a build.

## 11. Issue an API key

The CLI calls the api's admin endpoints with `ADMIN_TOKEN`, over `https://` only:

```sh
export NONPROFITS_URL=https://<your-project>.vercel.app
export ADMIN_TOKEN=<the ADMIN_TOKEN from step 8>
pnpm --filter @nonprofits/cli keys create --email <owner-email> --name <key-name>
```

The key is printed once. A shell variable wins over the local value in `packages/api/.env.local`, so the CLI talks to the deployed api while both are set. [API, locally](../README.md#api-locally) in the README lists the other `keys` commands (`list`, `revoke`, `set-limit`) and the limits a key gets.

## 12. Check it answers

The American Red Cross, EIN 530196605:

```sh
curl -H "Authorization: Bearer <your-key>" https://<your-project>.vercel.app/v1/orgs/530196605
curl https://<your-project>.vercel.app/v1/orgs/530196605    # keyless
```

Both answer with `AMERICAN NATIONAL RED CROSS`. The keyless tier allows 1 request a minute and 5 a UTC day per client, so a second keyless request inside a minute is a 429. A 503 names what is missing in its `code`:

| `code` | Means | Fix |
| --- | --- | --- |
| `server_misconfigured` | An environment variable is unset, too short or a placeholder; the body names each | Step 8, then redeploy |
| `auth_unavailable` | A Firewall rule isn't published, or the request couldn't be counted | Step 9 |
| `data_unavailable` | No build is served yet | Step 6 |

To connect an MCP client, see [MCP](../README.md#mcp) in the README, with `<api-url>` as `https://<your-project>.vercel.app`.

## The free Turso plan

The free plan includes 5 GB of storage, 500 million rows read and 10 million rows written a month. The api and the import are built to stay inside it, and these are the limits you own:

- **Storage.** A month of data is a database of about 2 GB. A refresh holds two of them, the one served and the new one, beside the app database: about 4.2 GB. So once the new one serves, the import deletes the old one. There is no rollback: last month's data is gone once this month's serves. A file over 2.4 GB is refused before anything is created, as that swap would no longer fit. A database the import couldn't delete holds storage until removed, and the next swap may not fit: the run's summary names the `turso db destroy <name> --yes` that removes it.
- **Rows read and written.** Each request the api counts writes 2 rows, and a search reads up to about 3,100. The service-wide daily ceilings, `SERVICE_KEYLESS_DAILY_LIMIT` for keyless callers and `SERVICE_KEY_DAILY_LIMIT` for default-tier keys, are 1,900 a day per tier by default (`DEFAULT_SERVICE_DAILY_LIMIT` in `packages/api/src/quota.ts`, which shows the arithmetic): sized so traffic at both ceilings stays inside the plan's reads. Past its ceiling, a tier is refused with 429 `service_daily_limit_reached` until the next UTC midnight; the other tier, and keys you whitelist with `keys set-limit`, are still served. Turso blocks queries past a plan's monthly quota, and the api then answers 503 until the month turns.
- **Inactivity.** The free plan archives databases unused for 10 days. If requests start failing after a quiet spell, `turso group unarchive nonprofits` brings them back.

Raising a ceiling, or moving to Turso's Developer plan ($4.99 a month, with more of each) when real traffic nears them, is your call. Check [Turso's pricing](https://turso.tech/pricing) and your usage under `turso plan show` before you do.

## Keeping it running

- The import runs at 06:17 UTC on the 3rd of each month. [Monthly import](../README.md#monthly-import) in the README covers its one switch (a dry run) and what a failed run leaves.
- The cron runs at 03:17 UTC each day: it deletes usage rows more than 7 days old, then runs the [freshness guard](../README.md#freshness-guard).
- To change a secret, edit it under **Settings > Environment Variables**, then redeploy. A new `TURSO_APP_DB_TOKEN` goes in the GitHub secret too.
- When you sync your fork with upstream, keep your workflows' `runs-on` through any conflict there.
