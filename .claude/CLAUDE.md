<!-- kru v0.141.0 · derived 2026-10-05 · /kru:setup to re-derive -->
## Team

Load **`kru:lead`** before building, reviewing, or dispatching a seat — it carries how the
team works.

- **api** → `kru:hono-builder` — `packages/api`, the Hono app serving `/v1`, `/mcp`, the admin key routes and the daily cron route, plus `packages/core`'s lookup and search logic (hono 4.13.13, `@modelcontextprotocol/server` 2.2.0)
- **platform** → `kru:vercel-platform-engineer` — `packages/api/vercel.json`, `build.ts` and `server.ts`: deploy, env and secrets, the daily cron, Firewall per-minute limits (`@vercel/firewall` 1.2.5, `@vercel/functions` 3.9.11)
- **data** → `kru:turso-specialist` — `packages/db`'s schema, migrations and the served-database pointer, and every `@libsql/client` 0.18.0 call in `packages/api` and `packages/import`
- **import** → `kru:extension-builder` — `packages/import`, the Node job that parses IRS bulk files into each month's SQLite file and `.github/workflows/import.yml` (csv-parse 7.0.3)
- **keys** → `kru:better-auth-specialist` — the API-key layer in `packages/api` and the key CLI in `packages/cli` (`better-auth` and `@better-auth/api-key` 1.7.7, on `kysely` 0.29.6)
- **skills** → `kru:vitest`, `zod`, `api-design` — vitest 5.0.3 and zod 4.6.5 (workspace catalog); `/v1` routes and minted API keys
- **verify** → `pnpm exec biome check .` and `pnpm typecheck` (root `package.json`), run before each commit by `.claude/skills/verify/`; `pnpm check` adds the whole Vitest suite
- **mcp** → Vercel (claude.ai connector) for live project state; the `turso@turso` plugin (`.claude/settings.json`), its MCP at `mcp.turso.ai` signed in by the user; context7 (`.mcp.json`)

A slice reaching a stack no seat above covers is a question for the user, naming the seat it would
need — never a nearby seat pressed into the gap.

**The repo is public.** Secrets live only in Vercel environment variables, GitHub Actions secrets, or the ignored `.env.*` files; API keys are stored hashed, never in plain text. `.gitignore` is the only thing that checks this.
