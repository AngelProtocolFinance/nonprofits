# nonprofits

Shared instructions for coding agents. Stack, commands, layout, conventions, and the Never list live here. Claude Code loads this file from `.claude/CLAUDE.md`; Cursor loads it from `.cursor/rules/project.mdc`.

## Stack

- **Node 24.** `.nvmrc` is `24`, root `engines.node` is `>=24`, and `@nonprofits/api` engines is `24.x`. CI (`.github/workflows/ci.yml` and `import.yml`) installs that file with `actions/setup-node` and does not name a patch. The Cursor cloud agent pins **24.21.0** (Node 24 LTS, Krypton, released 2026-09-07) in `.cursor/environment.json`, because neither `.nvmrc` nor CI names a patch.
- **pnpm 12.4.2**, the `packageManager` field. CI's `pnpm/action-setup` reads it. The cloud agent installs it with Corepack (`corepack prepare pnpm@12.4.2 --activate`), then `pnpm install --frozen-lockfile`.
- **TypeScript**, **Biome**, and **Vitest**, versions in the `catalog` of `pnpm-workspace.yaml`. `pnpm check` runs all three.
- **Libraries**, same catalog: Hono, `@modelcontextprotocol/server`, `@libsql/client`, `better-auth` and `@better-auth/api-key`, Kysely, Zod, `csv-parse`, `@vercel/firewall`, `@vercel/functions`. A package depends on a catalog entry with `"catalog:"`. Do not pin a different version in a package.

## Commands

CI's check job is these two commands, in order:

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` is `biome check .`, then `pnpm typecheck` (`pnpm -r --workspace-concurrency=1 typecheck`), then `vitest run`. That is the gate a change has to pass.

Before a commit, `.claude/skills/verify/` runs the quick pair: `pnpm exec biome check .`, then `pnpm typecheck`. `pnpm format` writes formatting. `pnpm test` is the Vitest suite without Biome or typecheck.

How to run the API, mint a local key, or build a month of IRS data: [CONTRIBUTING.md](CONTRIBUTING.md). How the suite is laid out: [TESTING.md](TESTING.md).

## Layout and boundaries

| Package | Owns | May import |
| --- | --- | --- |
| `@nonprofits/core` | EIN, lookup, search, result types | Nothing in the workspace. No runtime dependencies. |
| `@nonprofits/db` | Schema, app migrations, served-database pointer, search index, fixtures | `@libsql/client` only |
| `@nonprofits/api` | Hono app on Vercel: `/v1`, `/mcp`, admin key routes, daily cron | `core`, `db` |
| `@nonprofits/import` | Monthly IRS bulk-file job and `.github/workflows/import.yml` | `db` |
| `@nonprofits/cli` | API-key admin. Talks to the api over HTTP | In tests only, `@nonprofits/api/test-support` |

`import` does not import `api` or `core`. `api` does not import `import` or `cli`. `db` does not import `api` or `import`. `core` stays free of I/O, SQL, and framework code.

Other roots: `packages/api/vercel.json` (region, cron, build), `packages/api/.env.example` (every variable the api reads, placeholders only), `vitest.config.ts` (one project: `packages/*/{src,test}/**/*.test.ts`), `tsconfig.base.json`.

## Conventions

- ESM (`"type": "module"`). TypeScript is strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `NodeNext`. Import `.ts` extensions.
- Biome uses two-space indent and organizes imports. `biome check` is the format and import check; the linter preset is `none`.
- Tests use local libSQL files from `appDbFixture()` and `dataDbFixture()`, and each fixture is disposed. API tests build the app with `testApi()` and call `api.app.request`: no listening server. Limiters and the search cache read `testClock()`. The default fake `fetch` rejects every call.
- A value a test uses in place of a secret is a dummy, such as `test-only-better-auth-secret-0123456789abcdef`. Committed placeholders start with `replace-with-`. `isSecretSet` treats a placeholder, a short string, or an unset variable as unset. API keys are stored hashed.

## Never

- Never commit a secret, token, credential, or production environment value. This repository is public. Those values live in Vercel environment variables, GitHub Actions secrets, or a gitignored `.env.*` file. `.env.example` is the only committed env file, and it holds placeholders.
- Never put a real secret in `.cursor/environment.json`, docs, fixtures, logs, or tests. When a test needs a secret-shaped value, use a dummy.
- Never weaken a test so a change goes green: do not skip it, delete it, loosen the expected value, stub out the behavior it guards, or raise a timeout to hide a failure. Fix the code the test is about.
- Never point tests, fixtures, or the agent install at production Turso, Vercel, or GitHub credentials.
- Never let a test reach the network.
- Never store or log an API key in plaintext.
- Never install without `--frozen-lockfile` in CI or in `.cursor/environment.json`, and never hand-edit `pnpm-lock.yaml`.
- Never negate `.claude/skills` or `.claude/agents` in `.gitignore`. The cloud install lists those copies in `.git/info/exclude`, and a negation in `.gitignore` overrides that exclude.
