<!-- kru v0.141.0 · derived 2026-10-05 · /kru:setup to re-derive -->
@../AGENTS.md

## Team

Load **`kru:lead`** before building, reviewing, or dispatching a seat — it carries how the
team works.

- **api** → `kru:hono-builder` — `packages/api`, the Hono app serving `/v1`, `/mcp`, the admin key routes and the daily cron route, plus `packages/core`'s lookup and search logic
- **platform** → `kru:vercel-platform-engineer` — `packages/api/vercel.json`, `build.ts` and `server.ts`: deploy, env and secrets, the daily cron, Firewall per-minute limits
- **data** → `kru:turso-specialist` — `packages/db`'s schema, migrations and the served-database pointer, and every `@libsql/client` call in `packages/api` and `packages/import`
- **import** → `kru:extension-builder` — `packages/import`, the Node job that parses IRS bulk files into each month's SQLite file and `.github/workflows/import.yml`
- **keys** → `kru:better-auth-specialist` — the API-key layer in `packages/api` and the key CLI in `packages/cli`
- **skills** → `kru:vitest`, `zod`, `api-design` — `/v1` routes and minted API keys
- **verify** → the check commands in the imported AGENTS.md, run before each commit by `.claude/skills/verify/`
- **mcp** → Vercel (claude.ai connector) for live project state; the `turso@turso` plugin (`.claude/settings.json`), its MCP at `mcp.turso.ai` signed in by the user; context7 (`.mcp.json`)

A slice reaching a stack no seat above covers is a question for the user, naming the seat it would
need — never a nearby seat pressed into the gap.
