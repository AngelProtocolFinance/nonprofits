---
name: verify
description: Typecheck and lint this repo before a commit. Written by /kru:setup from the sheet's `verify` line.
---

Run from the repo root: `pnpm exec biome check .` then `pnpm typecheck`. Red → fix it before the commit; the commit waits.
