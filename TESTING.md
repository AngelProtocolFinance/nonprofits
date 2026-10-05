# Testing

`pnpm check` runs Biome, every package's typecheck and the whole Vitest suite. Most of its time is spent in tests that start workerd (worker, cli).

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

`packages/import/src/cli.ts` exports `run(argv, env, deps)`, which resolves the exit code; `deps` (`CliDeps`) carries everything it reaches outside its arguments (the databases `env` names, sources, floors, load dir, data file, the grace period's sleep, signal hook, `exit`). Its tests come in tiers:

- `cli-run.test.ts` calls `run()` in process. `harness({ wrap })` opens a local app database fixture through `openDatabases`, the wiring the CLI's own entry uses, and publishes a fixture build from an earlier month (`Date` faked for its build id) to local files, so every run starts with a database served; `wrap` swaps parts of the host, as `holdingUpload` holds the upload until the run's stop signal aborts it. `fixtureServer()`, `fixtureSources()` and `FIXTURE_COUNTS` (`test-support.ts`) serve a full fixture build and the floors it clears.
- `cli-redaction.test.ts` runs `run()` with a host whose failure quotes the env's tokens and one it minted during the run. Env secrets reach the summary writer and what `run` prints only through its `env` argument; the host's, through `host.secrets`.
- `workflow.test.ts` reads `.github/workflows/import.yml` and runs its shell steps (`bash -eo pipefail`, a stub `node`) and failure-issue script over summaries `renderSummary` writes, so a change to either side's text breaks a test; the import step's args go through `run()` to prove the CLI takes them.
- `summary.test.ts` covers `renderSummary` and `summaryWriter` directly.

No test spawns the CLI: the signal handlers and `process.exit` in its entry are the one part not run by a test.

## Things that bite

- `server.getLogs()` has no flush barrier: wrap log assertions in `vi.waitFor` and filter by `event`.
- Wrangler prints a warning on stderr when proxy environment variables are set, so never assert on the whole of stderr.
- `scripts/local-data.ts` writes `.wrangler/<name>.sql` under the worker package, so its tests live in one file to avoid racing on it.
- A refresh's build id is its start time to the second, so a test that runs two builds fakes `Date`.
- The loader tests (bmf, lists, efile) and `build.test.ts` load into a local libSQL file: `loadTarget`, `resetDataDb` and `query` in `test-support.ts`. `query` runs one statement; libSQL's `execute` silently drops any after the first.
