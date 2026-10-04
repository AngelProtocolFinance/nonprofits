# Testing

`pnpm check` runs Biome, every package's typecheck and the whole Vitest suite. It takes about 13 minutes, most of it spent in tests that start workerd (worker, cli) or spawn `wrangler d1 execute` (import).

## Layout

Two Vitest projects in `vitest.config.ts`:

- **`workerd`**: `packages/worker/test/**` and `packages/cli/test/**`. Each file boots workerd, through wrangler's `createTestHarness()` or a `wrangler` child process, so test and hook timeouts are 60 s.
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

## Import CLI tiers

`packages/import/src/cli.ts` exports `run(argv, env, deps)`, which resolves the exit code; `deps` (`CliDeps`) carries everything it reaches outside its arguments (D1, sources, load dir, signal hook, `stopWrangler`, `runningWrangler`, `exit`). Its tests come in tiers:

- `cli.test.ts` spawns the real CLI on local wrangler state: process-level behaviour (signals, exit codes, the real flip being killed). Slow; add a case here only when it needs a real process.
- `cli-run.test.ts` calls `run()` in process with fakes. `harness({ via, running, stop, sources })` puts in-memory D1 (`sqliteWrangler()`) behind `remoteD1`; `via` sees each wrangler command first and may stall or fail it, `stop`/`running` stand in for the wrangler kill, `fixtureServer()` and `fixtureSources()` (`test-support.ts`) serve a full fixture build. `run()` verifies against the real `TABLE_FLOORS`, so a fixture build never passes verify: tests that need a build to get that far assert on the check rows of the summary, not on a success.
- `cli-redaction.test.ts` runs `run()` through the real `wrangler.ts` with `fixtures/fake-wrangler.mjs` behind a mocked `execFile`, so the failure text is the shipped `failureOutput` shape (JSON cause, colour codes, the account id on later lines). Env secrets reach the summary writer only through `run`'s `env` argument.
- `workflow.test.ts` reads `.github/workflows/import.yml` and runs its release step (`bash -eo pipefail`, a stub `node`) and failure-issue script over summaries `renderSummary` writes, so a change to either side's text breaks a test.
- `summary.test.ts` covers `renderSummary` and `summaryWriter` directly.

## Things that bite

- `server.getLogs()` has no flush barrier: wrap log assertions in `vi.waitFor` and filter by `event`.
- Wrangler prints a warning on stderr when proxy environment variables are set, so never assert on the whole of stderr.
- `scripts/local-data.ts` writes `.wrangler/<name>.sql` under the worker package, so its tests live in one file to avoid racing on it.
- The import's refresh and verify tests run on in-memory SQLite through `sqliteWrangler()` (`packages/import/src/test-support.ts`), which stands in for the wrangler process only; one real-wrangler refresh and rollback stay. Process behaviour (timeouts, kills, argv, JSON output) is tested against `fixtures/fake-wrangler.mjs` behind a mocked `execFile`.
- A refresh's build id is its start time to the second, so a test that runs two builds fakes `Date`.
