<!-- kru v0.141.0 · derived 2026-10-05 · /kru:setup to re-derive -->
## Team

Load **`kru:lead`** before building, reviewing, or dispatching a seat — it carries how the
team works.

- **api** → `kru:hono-builder` — the Hono app on Vercel serving `/v1` and `/mcp`, plus `packages/core`'s lookup and search logic (platform-migration brief; `hono` not yet in any manifest)
- **platform** → `kru:vercel-platform-engineer` — the Vercel Pro project under that app: deploy, env and secrets, Cron for the freshness guard, per-minute limits (platform-migration brief)
- **data** → `kru:turso-specialist` — Turso: `packages/db`'s schema, the app database, and each month's data database uploaded from a built SQLite file (platform-migration brief)
- **import** → `kru:extension-builder` — `packages/import`, the Node job that parses IRS bulk files and builds that SQLite file (csv-parse 7.0.3)
- **keys** → `kru:better-auth-specialist` — `packages/cli` and the API-key layer; `better-auth` 1.7.7 and `@better-auth/api-key` (workspace catalog)
- **retiring** → `kru:cloudflare-builder` — `packages/worker` (wrangler 4.146.0, D1 bindings `APP_DB`, `DATA_DB_A`/`DATA_DB_B`), deleted by the platform migration
- **skills** → `kru:vitest`, `api-design` — vitest 5.0.3 (workspace catalog); `/v1` routes and minted API keys
- **verify** → `pnpm exec biome check .` and `pnpm typecheck` (root `package.json`), run before each commit by `.claude/skills/verify/`; `pnpm check` adds the whole Vitest suite
- **mcp** → Vercel (claude.ai connector) for live project state ← this session's tool list; the `turso@turso` plugin at project scope (`.claude/settings.json`), its MCP at `mcp.turso.ai` OAuth-scoped by the user; context7 at user scope, `.mcp.json` on the cloud vm

A slice reaching a stack no seat above covers is a question for the user, naming the seat it would
need — never a nearby seat pressed into the gap.

**The repo is public.** Secrets live only in Vercel environment variables, GitHub Actions secrets, or the ignored `.dev.vars` and `.env.*` files; API keys are stored hashed, never in plain text. `.gitignore` is the only thing that checks this.
