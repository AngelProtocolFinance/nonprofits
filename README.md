# nonprofits

Look up IRS exempt organizations by EIN, over REST and MCP.

## Layout

pnpm workspace, one package per deliverable plus shared code:

- `packages/core`: response types, lookup and search shared by REST and MCP
- `packages/db`: the app database's migrations and the served-database pointer, the data databases' schema and search index, and the table/column constants shared by api and import
- `packages/api`: Hono app on Vercel serving REST, MCP, the admin endpoints the CLI calls, and the daily cron
- `packages/import`: Node job that builds each month's IRS data into one SQLite file and publishes it to Turso
- `packages/cli`: API key admin

Node 24 (`.nvmrc`), pnpm pinned via `packageManager`. Dependency versions live in the `catalog` in `pnpm-workspace.yaml`.

## Gate

```sh
pnpm check
```

Runs Biome, `tsc --noEmit` per package, and Vitest, sequentially. CI runs the same command.
See [TESTING.md](TESTING.md) for how the suite is laid out. `pnpm format <paths>` formats only the paths given.

## Deploy your own

From a fork, on your own Vercel (Pro) and Turso (free plan) accounts: the api serving REST and MCP on a `vercel.app` address, Turso databases holding the keys and the IRS data, a monthly GitHub Actions import that rebuilds the data, and API keys you issue with the CLI. [docs/deploy.md](docs/deploy.md) walks through it in order.

## API, locally

From the repository root, after `pnpm install --frozen-lockfile`:

```sh
pnpm --filter @nonprofits/api dev                    # http://localhost:8787 (PORT to change)
curl http://localhost:8787/v1/orgs/530196605         # the American Red Cross; keyless, so 1 a minute
```

What the dev server serves, in order, logged at start:

1. `TURSO_APP_DB_URL` set: that app database's pointer (it refuses to start if the pointer names no build yet).
2. `.turso/app.db` holds a pointer to a build, as it does after a local `irs refresh` ([Import](#import)): that build. So the whole month, locally:
   ```sh
   pnpm --filter @nonprofits/db migrate
   pnpm --filter @nonprofits/import irs refresh
   pnpm --filter @nonprofits/api dev
   ```
3. Otherwise: fresh databases in a temp directory, deleted on exit, serving the eight orgs of `packages/db/fixtures/seed.sql`, the Red Cross among them.

Its per-minute limits and search cache are in memory, and with no `IP_HASH_SECRET` set each run hashes clients with a fresh key, so keyless counts reset on restart.

A request with no `Authorization` header is served keyless: 5 requests per UTC day and 1 per minute per client. A client is its IP from Vercel's `x-real-ip` header (an IPv6 address counts as its /64), stored only as an HMAC keyed by the `IP_HASH_SECRET` secret, never the raw IP. A key lifts the keyless limits, sent as `Authorization: Bearer <key>`; a malformed, unknown or revoked key is a 401, never served keyless. Keys are issued and revoked through the api's admin endpoints, which stay off until `packages/api/.env.local` (gitignored; the CLI reads it too) sets `ADMIN_TOKEN` and `BETTER_AUTH_SECRET`. Write it, then restart the dev server:

```sh
printf 'ADMIN_TOKEN=%s\nBETTER_AUTH_SECRET=%s\n' "$(openssl rand -base64 32)" "$(openssl rand -base64 32)" > packages/api/.env.local
pnpm --filter @nonprofits/cli keys create --email <owner-email> [--name <name>]   # prints the key once
curl -H "Authorization: Bearer <key>" http://localhost:8787/v1/orgs/530196605
curl -H "Authorization: Bearer <key>" "http://localhost:8787/v1/search?q=red%20cross"
pnpm --filter @nonprofits/cli keys list                 # status, tier, limits, today's usage; never a key
pnpm --filter @nonprofits/cli keys set-limit <key-id> --daily 500 --per-minute 60
pnpm --filter @nonprofits/cli keys set-limit <key-id> --default
pnpm --filter @nonprofits/cli keys revoke <key-id>
```

`packages/api/.env.example` lists every variable the deployed api reads; the dev server reads the same names from `.env.local`, and an empty one or a placeholder counts as unset.

Each key gets 50 requests per UTC day and 10 per minute; lookups and searches count alike. A request refused by a limit is not counted, and neither is one refused for its input (a malformed EIN or query) or one answered 503 because no data is served. Repeated searches are answered from Vercel's Runtime Cache for up to an hour, keyed by the served data build, and still count. Every 429 is problem details with `Retry-After`:

| `code` | When |
| --- | --- |
| `per_minute_limit_exceeded` | Past a per-minute limit. Deployed, default keys and keyless callers meet the `key-burst` and `keyless-burst` Vercel Firewall rules (fixed 60 s windows); `Retry-After: 60`. Any request carrying a key, valid or not, also meets `keyed-requests`: 600 a minute per client, before the key is read. Locally the same limits are counted in memory. |
| `daily_quota_exceeded` | Past the caller's daily quota; `Retry-After` to the next UTC midnight. |
| `service_daily_limit_reached` | A tier is past its service-wide daily limit, an environment variable: `SERVICE_KEY_DAILY_LIMIT` for default keys, `SERVICE_KEYLESS_DAILY_LIMIT` for keyless callers, so neither tier can use up the other's. Each defaults to `DEFAULT_SERVICE_DAILY_LIMIT` in `packages/api/src/quota.ts`, sized to the free Turso plan's reads. `Retry-After` to the next UTC midnight. A value that isn't a positive integer refuses that tier with 503 until fixed. |

`set-limit` whitelists a key with its own daily and per-minute limits, counted exactly per clock minute in the app database, outside the Firewall rules and the service-wide limits; `--default` puts it back. The per-minute limit is at most 600: `keyed-requests` caps every client there first, so the admin endpoint refuses a higher one. Usage lives in `key_usage`, one row per key or hashed client per day plus each tier's service row (`*:key`, `*:keyless`), which imports never touch; a daily Vercel Cron job (`17 3 * * *`, `GET /cron/daily` with `Authorization: Bearer <CRON_SECRET>`) deletes rows more than 7 days old, then runs the [freshness guard](#freshness-guard).

Against the deployed api, set `NONPROFITS_URL` and `ADMIN_TOKEN` in the shell; they win over `.env.local`. The CLI sends `ADMIN_TOKEN` only over `https://`, or plain `http://` to `localhost`, `127.0.0.1` or `[::1]`; it never follows a redirect, and a path prefix in `NONPROFITS_URL` is kept. The admin endpoints answer 503 `admin_disabled` until both `ADMIN_TOKEN` and `BETTER_AUTH_SECRET` are set to at least 32 characters other than the `.env.example` placeholder. `pnpm --filter @nonprofits/api auth:generate` prints the SQL for the next migration in `packages/db/migrations/app/` when better-auth's schema for the current plugins needs one.

## MCP

The api also serves `/mcp` (streamable HTTP, stateless) with two tools: `lookup_nonprofit` (`ein`) and `search_nonprofits` (`query`, optional `limit`). Each answers with the REST JSON as structured content, and as text after a short rendering. A REST error comes back as a tool error (`isError: true`) carrying the REST problem body, plus `retryAfterSeconds` on a 429. Connect Claude Code:

```sh
claude mcp add --transport http nonprofits <api-url>/mcp --header "Authorization: Bearer <key>"
claude mcp add --transport http nonprofits <api-url>/mcp   # keyless
```

Keyless `/mcp` is limited per IP address, so it suits a client running on one machine. A hosted connector (claude.ai, ChatGPT and the like) calls from its provider's servers, so all of its users would share one IP's keyless limits: it isn't a supported keyless client. Configure it with a key instead (ask the operator for one).

Auth and limits are REST's: a malformed, unknown or revoked key is the same 401 problem before any MCP message is read, no `Authorization` header is the keyless tier, and each tool call counts as one request on the same counters as REST. Protocol messages (the handshake, tool listings) count toward no quota, but HTTP requests are capped per client whatever messages each carries: those carrying a key by `keyed-requests`, keyless ones by `keyless-mcp-requests` (60 HTTP requests a minute, then `per_minute_limit_exceeded`). A batch of tool calls in one request counts each call. `subscriptions/listen` is refused: the tools never change.

A 401 carries a `Bearer` challenge, which some MCP clients show as an OAuth or login prompt. Here it always means the key is wrong: check it was copied whole, or ask the operator for a new one.

To try it against `pnpm --filter @nonprofits/api dev`:

```sh
npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp --method tools/list
```

## Import

`irs refresh` builds a whole new month of the IRS data into one SQLite file, checks it against the database served now, and publishes it: uploads it as a new data database, switches the served-database pointer in the app database to it, and deletes the one served before. `irs build` builds and checks the file alone:

```sh
pnpm --filter @nonprofits/db migrate                     # once: the local app database, .turso/app.db
pnpm --filter @nonprofits/import irs refresh             # every source: ~10 GB of downloads, about an hour
pnpm --filter @nonprofits/import irs build               # the same file, data/nonprofits.db, never published
pnpm --filter @nonprofits/import irs build --efile-batch 2026_TEOS_XML_03A   # e-file from these batches alone: a partial file
```

Where it publishes follows `TURSO_APP_DB_URL`. Unset, or any URL but a Turso Cloud one, the app database is that local one (`.turso/app.db` when unset) and each data database is a file under `.turso/data/`: a stand-in for Turso that the dev server doesn't read ([API, locally](#api-locally)). A Turso Cloud app database (`libsql://` or `https://`) publishes through Turso's Platform API and needs `TURSO_APP_DB_TOKEN`, `TURSO_PLATFORM_TOKEN`, `TURSO_ORG` and `TURSO_GROUP`; a run missing one fails before it downloads anything, naming each.

`--summary <file>` on `refresh` appends a markdown summary of the run to the file, failed or stopped too: the database and build served before and after, each source's rows and release date (each e-file index's, by year), the e-file release years read and why, each form's yields, every verify check with its numbers and time, and each step's time. A failure is one line starting `**Failed:**`, a stop one starting `**Stopped:**` followed by what its cleanup did, a failed or stopped run that left the pointer as it was one starting `**Nothing switched:**`, and a database left behind one starting `**Cleanup:**` with the command that removes it. Free text is cut to fit GitHub's step summary: a line to its first 1,000 characters, a failure's later lines to their last 100 lines or 16 KiB, each saying what was cut. The values of `TURSO_APP_DB_TOKEN` and `TURSO_PLATFORM_TOKEN`, every token minted during the run, and those values trimmed, are replaced with `[redacted]`, there and in what the CLI prints.

`refresh --force-verify-failure` builds and checks the whole file as usual, then fails verify with one more check, `forced failure`, so nothing is published: a dry run of every step but the upload and switch, and of what a failed run does.

A refresh logs one line per step, with its time:

1. Read the pointer, then the served database's counts, while one is served.
2. Build the file at `data/nonprofits.db`, in the format Turso's upload takes (WAL, 4096-byte pages, auto-vacuum off), beside it at `data/nonprofits.db.building` until verify passes: bmf, pub78, revocation, epostcard and efile (the full run), in that order, each streaming into its own SQL file under `load/` and applied in one transaction, holding its own floors first: a drifted layout or a short count aborts before the apply.
3. Build the search index and `data_meta`, once.
4. Verify, one query per check, each logged with its time:
   - each table holds at least its floor: 2,948,000 orgs (90% of the October 2026 build), 684,000 filings (90% of the 760,592 latest filings a full run selects) and 750,000 programs (80% of ~939,500, extrapolated from batch 2026_TEOS_XML_03A). These are what a first build, with nothing served to compare, is held to;
   - each list landed: at least 1,277,000 orgs in Pub 78, 1,104,000 with a revocation date, 1,392,000 990-N filers and 1,768,000 from the BMF (90% of the October 2026 build's 1,419,989, 1,227,606, 1,546,723 and 1,964,958);
   - those counts, orgs, filings and programs each within ±10% of the served database's, skipped while none is served yet;
   - Red Cross (530196605) present with a mission, and in Pub 78;
   - one search index row per named org;
   - no row without an EIN.
5. Publish: create `nonprofits-data-<build id>`, upload the file, check the copy holds the build, the Red Cross and every count the file held, then switch the pointer to it, a compare-and-set that fails if another publish switched first. The api picks it up within 30 s; 60 s after the switch the database served before is deleted. A file over 2.4 GB is refused before anything is created: a swap holds it, the served database and the app database within the free Turso plan's 5 GB.

Any failure before the switch exits 1 with the pointer unchanged, the database served before still serving, and the database being made deleted. There is no rollback: once a new database serves, the one before it is deleted. A previous database that can't be deleted is left serving nothing, holding storage, and the run's `**Cleanup:**` line names the `turso db destroy <name> --yes` (or, locally, the `rm -f`) that removes it.

A download that drops, stalls for a minute, or is answered 5xx or 429 is tried again, 4 tries in all, about 2, 4 and 8 s apart, each retry logged; a 404 or another 4xx fails at once. The retry starts the file over: a BMF or list load from its first byte (the BMF from eo1, as its four files stream into one load), the e-file indexes all over, one batch zip on its own.

SIGINT or SIGTERM stops the run within 7 s, exiting 130 or 143: GitHub Actions follows a cancel's SIGINT with SIGTERM 7.5 s later and SIGKILL at 10 s. During the build it exits once it has read the pointer, leaving the half-built file for the next build to delete. During the publish it aborts the upload and deletes the database being made, unless the pointer already names it; a stop during the 60 s wait after the switch leaves the database served before in place, named in the `**Cleanup:**` line. Either way it prints and records what the pointer serves. A stop cut off at 7 s while the publish is still running can't tell whether the switch landed: its line says to read what the pointer names first, and names the command that removes the database being made only for when the pointer doesn't name it. A signal during that cleanup waits for it. `pnpm --filter … irs` doesn't pass a signal sent to pnpm on to the CLI (the CLI keeps running, and outlives a killed pnpm), so a job that may be cancelled runs `node packages/import/src/cli.ts refresh` itself, with `exec` in a shell step: the Actions runner signals only the step's shell, which doesn't pass it on. Ctrl-C in a terminal signals the whole process group and reaches it either way.

`build` checks its counts against the served database's too, while one is served. `--efile-batch` builds a partial file: it skips the filings and programs floors and the served counts, and `refresh` refuses it, as publishing it would serve a fraction of the filings.

Exit codes: 0 done, 1 failed, 2 usage, 130/143 interrupted.

The e-file load reads the 990 e-file index of the three latest release years (starting a year earlier while this year's index isn't published: apps.irs.gov answers 404, or redirects to its `/404` page), and a fourth while the newest index lists under half the rows of the year before (January to spring, when it holds a few weeks of filings, and three years would drop one the floors count on); it keeps each EIN's latest filing (latest tax period, then latest received, amendments included), and parses those returns out of the batch zips, one zip on disk at a time under `data/efile/`: a Form 990's mission, activity summary, website, top 3 programs and finances (total revenue, expenses, assets at year end); a 990-EZ's primary exempt purpose as its mission, website, top 3 programs and finances; a 990-PF's website and finances. A mission that only points to Schedule O is stored as null and flagged `mission_on_schedule_o`; an activity summary that only points there is stored as null. A program with no description and no amount but 0 (an empty placeholder) is no program. Index rows of other return types (990-T, or one the IRS adds) are counted by type in the run's output. A return whose EIN, form type, an amount or its tax year can't be read, or whose XML is malformed, cut off or fails to inflate, is rejected and skipped, and that EIN's runner-up filing (its next-latest) is read in its place, from whichever batch holds it; when that is rejected too, the EIN gets none. More than 1% of latest filings rejected, or a form's returns (run-wide, or in a returnVersion with 200+ of them) under its yield floors (mission and revenue for the 990, mission and all three finances for the 990-EZ, all three finances for the 990-PF) aborts before anything is loaded, as does a full run that selects none of a form. A full run deletes the filings it didn't write and the orgs left with no fact and no filing; an `--efile-batch` build deletes nothing.

## Monthly import

`.github/workflows/import.yml` runs `irs refresh` against Turso at 06:17 UTC on the 3rd of each month, after the IRS's month-end revocation list and its mid-month BMF, Pub 78 and e-file index refreshes. It needs five repository secrets: `TURSO_APP_DB_URL` (the app database's `libsql://` URL) and `TURSO_APP_DB_TOKEN` (read-write on it), `TURSO_PLATFORM_TOKEN` (a Platform API token for the data databases' group: `turso auth api-tokens mint nonprofits-import --org <org> --group <group> --scope db:create --scope db:mint-token --scope db:delete`), `TURSO_ORG` and `TURSO_GROUP`. Its first step fails, naming each one missing, or an app database that isn't a Turso Cloud one, before anything else runs. Runs never overlap: a second waits for the first, and a third cancels the one waiting.

Run it by hand from the Actions tab (**Run workflow**). Its one switch, **force_verify_failure**, runs `refresh --force-verify-failure`, which builds and checks everything and then fails, leaving the served database as it was. There is no rollback: a refresh deletes the database served before once the new one serves.

The run's summary page shows the CLI's `--summary`, and warns when its `**Cleanup:**` line names a database left behind, which holds storage, so the next swap may not fit, until removed. A failed run is red, and opens an issue titled "Monthly IRS import failed" with the run's link, the summary's `**Failed:**` (or `**Stopped:**`) line and any `**Nothing switched:**` and `**Cleanup:**` lines, or comments on that issue while it is open. GitHub notifies the repository's watchers of the issue and each comment, beyond its failed-run email; close the issue once the import is fixed. A cancelled run, or one stopped by the import step's timeout (which GitHub counts as a failure, not a cancel), deletes the database it was making itself.

The job runs on a Blacksmith runner (`blacksmith-4vcpu-ubuntu-2404`, as CI does) and has 350 minutes, the import step 335 of them. A full run downloads about 10 GB, one e-file batch zip on disk at a time; the step before the import logs the runner's free disk, and the last one deletes `data/` (the downloads and the built file) and `load/`.

## Freshness guard

GitHub disables a public repository's scheduled workflows after 60 days without repository activity, and can drop a scheduled run, with no alert either way. So the api's daily cron also checks the served data's age, on the app database's clock: when the database `served_database` names was switched to more than `STALE_AFTER_DAYS` (35) days ago, or no build was ever served, it enables `import.yml` through GitHub's API, which also brings back its monthly schedule if GitHub disabled it, then dispatches it on `main` with no inputs; a run already going queues the new one. It doesn't within `REDISPATCH_AFTER_HOURS` (72) of its last dispatch. That dispatch's time and GitHub's HTTP status (the enable call's, when that failed and nothing was dispatched) are kept in `served_database` (`last_dispatch_at`, `last_dispatch_status`), stamped before the calls, so a failing token is retried every 72 hours rather than daily. Each run logs one line: `data_fresh`, `import_dispatched` with GitHub's status (and the start of its answer when not 2xx), `import_enable_failed` likewise, or `import_dispatch_skipped` with a `reason` (`dispatched_recently`, `token_unset`, `invalid_config`, or `no_longer_due` when another run of the cron dispatched first); a check that throws logs `freshness_check_failed` instead.

It needs the `GITHUB_DISPATCH_TOKEN` environment variable: a fine-grained personal access token limited to this repository, with the **Actions** repository permission set to read and write. Where it is unset, shorter than 32 characters or still the `.env.example` placeholder, a run that finds the data stale skips with a `token_unset` warning. `GITHUB_REPO` defaults to the GitHub repository Vercel deployed from; `STALE_AFTER_DAYS` and `REDISPATCH_AFTER_HOURS` default to the values above. One that isn't valid skips the check with an `invalid_config` line naming it.

## License

MIT, see [LICENSE](LICENSE). The IRS data the import loads is public.
