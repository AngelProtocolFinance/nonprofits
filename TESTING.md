# Testing

`pnpm check` runs Biome, every package's typecheck and the whole Vitest suite.

## Layout

One Vitest project in `vitest.config.ts`: every `packages/*/{src,test}/**/*.test.ts`, in Node, on Vitest's defaults unless a file says otherwise. Databases in tests are local libSQL files: `appDbFixture()` and `dataDbFixture(buildId)` from `@nonprofits/db/fixture` make a migrated app database and a data database holding `packages/db/fixtures/seed.sql`, each deleted by its `dispose()`.

API tests:

- `testApi()` (`packages/api/src/test-support.ts`) builds the app over those fixtures, the pointer serving the data fixture, with in-memory limiters and search cache on a `testClock()` the test moves. A test sends its requests with `api.app.request`: no server, no port. Options swap in a failing database (`failingDb`), the Firewall limiters over a stubbed check (`limiters`), a fake `fetch` for GitHub's API (the default rejects every call, so no test reaches the network), or a pointer that serves nothing (`serve: false`).
- `firewall-limiter.test.ts` covers the four Vercel Firewall limiters with the Firewall's verdict stubbed. Off Vercel the SDK-backed limiter throws instead of calling anything, so the suite never reaches Vercel.
- `deploy.test.ts` reads `packages/api/vercel.json` (region, cron path and schedule), runs `build.ts` and boots the bundle in plain Node against an app database fixture, and checks `.env.example` names exactly the variables `PRODUCTION_ENV` (`src/production.ts`) reads.

`packages/cli/test/cli.test.ts` serves `testApi()` over `@hono/node-server` on a free port and runs the CLI's `run()` against it.

## Clocks

- Key and IP usage is counted per UTC day. `testClock()` starts at 2026-10-05T12:00:00Z, clear of a UTC midnight; `set` and `advance` move it, and the limiters, quotas and search cache all read it.
- `freshClient()` gives a keyless request an `x-real-ip` no other request in the run uses, so one test's keyless quota never spends another's.

## Import CLI tiers

`packages/import/src/cli.ts` exports `run(argv, env, deps)`, which resolves the exit code; `deps` (`CliDeps`) carries everything it reaches outside its arguments (the databases `env` names, sources, floors, load dir, data file, the grace period's sleep, signal hook, `exit`). Its tests come in tiers:

- `cli-run.test.ts` calls `run()` in process. `harness({ wrap })` opens a local app database fixture through `openDatabases`, the wiring the CLI's own entry uses, and publishes a fixture build from an earlier month (`Date` faked for its build id) to local files, so every run starts with a database served; `wrap` swaps parts of the host, as `holdingUpload` holds the upload until the run's stop signal aborts it. `fixtureServer()`, `fixtureSources()` and `FIXTURE_COUNTS` (`test-support.ts`) serve a full fixture build and the floors it clears.
- `cli-redaction.test.ts` runs `run()` with a host whose failure quotes the env's tokens and one it minted during the run. Env secrets reach the summary writer and what `run` prints only through its `env` argument; the host's, through `host.secrets`.
- `workflow.test.ts` reads `.github/workflows/import.yml` and runs its shell steps (`bash -eo pipefail`, a stub `node`) and failure-issue script over summaries `renderSummary` writes, so a change to either side's text breaks a test; the import step's args go through `run()` to prove the CLI takes them.
- `summary.test.ts` covers `renderSummary` and `summaryWriter` directly.

No test spawns the CLI: the signal handlers and `process.exit` in its entry are the one part not run by a test.

## Things that bite

- A refresh's build id is its start time to the second, so a test that runs two builds fakes `Date`.
- The loader tests (bmf, lists, efile) and `build.test.ts` load into a local libSQL file: `loadTarget`, `resetDataDb` and `query` in `test-support.ts`. `query` runs one statement; libSQL's `execute` silently drops any after the first.
- The bundle test in `deploy.test.ts` runs esbuild and a child Node, so it has its own 30 s timeout.
