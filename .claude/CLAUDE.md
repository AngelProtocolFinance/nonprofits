<!-- kru v0.137.0 · derived 2026-10-04 · /kru:setup to re-derive -->
## Team

Load **`kru:lead`** before building, reviewing, or dispatching a seat — it carries how the
team works.

- **app** → `kru:nextjs-builder` — Next.js App Router route handlers on Vercel serving `/v1` and `/mcp`, plus `packages/core`'s lookup and search logic (Vercel + Turso decided 2026-10-04; `next` not yet in any manifest)
- **platform** → `kru:vercel-platform-engineer` — the Vercel Pro project: env and secrets, Cron for the freshness guard, Firewall rate-limit rules (same decision)
- **data** → no seat — Turso (libSQL): `packages/db`'s schema, the app database, and each month's data database uploaded from a built SQLite file (same decision); a slice here is the question below
- **import** → `kru:extension-builder` — `packages/import`, the Node job that parses IRS bulk files into load SQL (csv-parse 7.0.3); its D1 path gives way to building that SQLite file
- **keys** → `kru:better-auth-specialist` — `packages/cli` and the API-key layer; decided in the hosted-ein-lookup brief (2026-10-03); `better-auth` 1.7.7 and `@better-auth/api-key` in `packages/worker` (workspace catalog), its database moving to Turso
- **retiring** → `kru:cloudflare-builder` — `packages/worker` (wrangler 4.146.0, D1 bindings `APP_DB`, `DATA_DB_A`/`DATA_DB_B`) until the Vercel app replaces it
- **skills** → `kru:vitest`, `api-design` — vitest 5.0.3 (workspace catalog); `/v1` routes and minted API keys
- **mcp** → Vercel (claude.ai connector) for live project state ← this session's tool list; context7 at user scope, `.mcp.json` on the cloud vm

A slice reaching a stack no seat above covers is a question for the user, naming the seat it would
need — never a nearby seat pressed into the gap.

**The repo is public.** Secrets live only in Vercel environment variables, wrangler secrets (until the Worker retires), GitHub Actions secrets, or the ignored `.dev.vars` and `.env.*` files; API keys are stored hashed, never in plain text. `.gitignore` is the only thing that checks this.
