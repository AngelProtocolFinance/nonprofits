<!-- kru v0.137.0 · derived 2026-10-03 · /kru:setup to re-derive -->
## Team

Load **`kru:lead`** before building, reviewing, or dispatching a seat — it carries how the
team works.

- **edge** → `kru:cloudflare-builder` — `packages/worker`, `packages/core`, `packages/db`: the Worker, the REST/MCP handler layer it serves, and the D1 migrations (wrangler 4.146.0, bindings `APP_DB` (auth, quota, data pointer) and `DATA_DB_A`/`DATA_DB_B` (blue/green IRS data))
- **import** → `kru:extension-builder` — `packages/import`, the Node job that parses IRS bulk files into D1 load SQL (csv-parse 7.0.3)
- **keys** → `kru:better-auth-specialist` — `packages/cli` and the API-key layer; decided in the hosted-ein-lookup brief (2026-10-03); `better-auth` 1.7.7 and `@better-auth/api-key` in `packages/worker` (workspace catalog)
- **skills** → `kru:vitest`, `api-design` — vitest 5.0.3 (workspace catalog); `/v1` routes and minted API keys
- **mcp** → Cloudflare Developer Platform (claude.ai connector) for live account state ← `claude mcp list`; context7 and chrome-devtools inherited at user scope

A slice reaching a stack no seat above covers is a question for the user, naming the seat it would
need — never a nearby seat pressed into the gap.

**The repo is public.** Secrets live only in wrangler secrets, GitHub Actions secrets, or the ignored `.dev.vars`; API keys are stored hashed, never in plain text. `.gitignore` is the only thing that checks this.
