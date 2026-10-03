# Testing

`pnpm check` runs Biome, every package's typecheck and the whole Vitest suite. It takes about 13 minutes, most of it spent in tests that start workerd (worker, cli) or spawn `wrangler d1 execute` (import).

## Layout

Two Vitest projects in `vitest.config.ts`:

- **`workerd`**: `packages/worker/test/**` and `packages/cli/test/**`. Each file boots its own workerd through wrangler's `createTestHarness()`, so test and hook timeouts are 60 s.
- **`node`**: everything else (core, db, import), on Vitest's defaults unless a file says otherwise.

Worker tests come in two tiers:

- `packages/worker/test/*.test.ts` talk HTTP to the Worker in the harness.
- `packages/worker/test/direct/*.test.ts` call the handlers with the harness's bindings, which is cheaper and lets a test swap in fakes (a failing D1, a counting limiter). They have their own tsconfig: Worker types, no Node types.

## Clocks

- Key and IP usage is counted per UTC day. Tests that need a particular day use `virtualDay(n)` / `virtualAt(n)` from `test/virtual-clock.ts`: days in 2001, which the real clock never reaches.
- A test that has to use the real clock calls `clearOfUtcMidnight()` first, and `startOfMinuteWindow(margin)` / `startOfBurstWindow()` from `test/clock-windows.ts` before a burst that has to fit inside one minute.

## Rate limits

- The Rate Limiting bindings are exact in miniflare and approximate in production. Most tests use `countingLimiter(limit)` or `noBurstLimit` from `test/direct/limiters.ts`; each binding keeps one real burst test.
- `test/direct/ratelimits-config.test.ts` checks that the limits in `wrangler.jsonc` match the constants in `quota.ts`.

## Things that bite

- `server.getLogs()` has no flush barrier: wrap log assertions in `vi.waitFor` and filter by `event`.
- Wrangler prints a proxy warning on stderr in this environment, so never assert on the whole of stderr.
- `scripts/local-data.ts` writes `.wrangler/<name>.sql` under the worker package, so its tests live in one file to avoid racing on it.
- The import's refresh tests spawn real `wrangler d1 execute --local` many times each; the remote path is tested through the injectable runner (`localD1` / `remoteD1` take a `run`).
