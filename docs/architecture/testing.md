# Testing

Tests are split into tiers by file name, run through one `suites` wrapper over Bun, and run after every land and in CI.

```mermaid
flowchart LR
    file["*.test.ts"] --> suites(["suites<br/>bun test"])
    suites -->|"unit · 20 s hang bound"| unit["unit run"]
    suites -->|"*.integration / *.e2e · 120 s"| integ["integration run"]
    integ -.->|"INTENTIC_E2E* switch<br/>plus credentials"| e2e["e2e tiers"]
```

## Suites

- Every package's `test` script is `suites` ([`_tools/testing/bin/suites.mjs`](../../_tools/testing/bin/suites.mjs)). It runs `bun test --conditions=@intentic/src --isolate` twice, because one run has one timeout: unit files with a 20-second hang detector, then `*.integration.test.*` and `*.e2e.test.*` files with room for real work.
- The kind comes from the file name alone (`suiteKindOf` and `SUITE_TIMEOUTS` in [`test-suites.mjs`](../../_tools/constants/src/test-suites.mjs)). Each package's `bunfig.toml` preloads [`bun-preload.ts`](../../_tools/testing/src/bun-preload.ts), so a plain `bun test` gets the same budget.
- A suite that reaches the machine (temp directories, subprocesses, real git, Docker) must be named `*.integration.test.ts`. [`test-programs.mjs`](../../_tools/checks/test-programs.mjs) recognizes one by what it imports, fixtures included. The same check requires every test file to be inside a type-check program and every `jest.mock` of a workspace package to supply every name the code under test imports.
- [`@intentic/testing`](../../_tools/testing) holds the shared seams: `unstubbed` (a fake whose unstubbed members throw with their own name), Bun helpers such as `waitFor` and `freshImport`, a DOM, and Fly and Stripe fakes. `requires(condition, why)` gates a test on something of the machine: it stands down locally, with `suites` counting what stood down, and fails on CI. A suite takes `describe`, `test` and `expect` from the globals `bun test` defines; a value import from `bun:test` hides it from the `jest/*` lint rules, and `.oxlintrc.json` refuses one. A package's own fixtures live in its `src/testing.ts`. The rules for writing tests are in [`AGENTS.md`](../../AGENTS.md).
- Other runners: Playwright for the browser and onboarding tiers, `cargo test` for the Rust crates, and `node:test` for the scripts in `_tools/scripts`.

## Tiers

| Tier | What it needs | Where it runs |
| --- | --- | --- |
| Unit | nothing outside the process | after a land, CI |
| Integration | temp trees, git, subprocesses, Docker | after a land, CI |
| `pnpm e2e` | Docker for the daemon image, plus Cloudflare, Discord, Stripe or Fly credentials; `e2eTier` makes a suite stand down without them | nightly |
| `e2e:hermetic` | a Docker-in-Docker host from [`_tools/dind-host`](../../_tools/dind-host), Postgres, faked Stripe | CI |
| `e2e:providers` | the real agent CLIs against [`_tools/fake-model`](../../_tools/fake-model), no network | CI before a release; nightly with the newest CLIs |
| `e2e:browser` | Playwright ([`_tools/e2e`](../../_tools/e2e)) against a localhost Postgres, API, Vite and daemon container | a developer machine |
| `e2e:mobile` | Chromium over the demo build, checking every mobile route's geometry | `pnpm e2e:mobile` |
| Onboarding | Playwright ([`_tools/onboarding`](../../_tools/onboarding)) with [`_tools/fake-upstream`](../../_tools/fake-upstream) standing in for model endpoints | nightly |
| Desktop smoke | installed desktop builds ([`_tools/desktop-smoke`](../../_tools/desktop-smoke), [`_tools/desktop-smoke-windows`](../../_tools/desktop-smoke-windows)) | CI, release, nightly |
| Mutation | [`stryker.conf.mjs`](../../stryker.conf.mjs) over unit suites of the daemon and its contract | the daemon's `test-strength` chore |
| Perf | Valgrind for instruction counts, Chromium over the demo for render, call, layout and mutation counts ([`_tools/perf`](../../_tools/perf)) | CI, when a change reaches `@intentic/perf` or the demo |

## Where they run

- **After a land**, `pnpm verify` ([`verify.mjs`](../../_tools/scripts/verify/verify.mjs)): the whole repository, run by the daemon on the main tree in the background ([`verify-deps.ts`](../../_sandbox/sandbox/src/workspace/deps/verify-deps.ts)). Nothing runs the tests automatically inside a turn. A failed test is re-run alone before it counts, and [`flakes.mjs`](../../_tools/scripts/verify/flakes.mjs) logs one that passes then as a flake. The assertion ratchet counts a test file the land made weaker, without a `test!:` subject or `Test-Note:` trailer, as a failure. The verdict is recorded for the push, and a red one goes to the conversation that landed the work or to a fresh fix-up ([`land-breakage.ts`](../../_sandbox/sandbox/src/agents/land/land-breakage.ts)). The owner can send it to a runner on one of their machines instead (settings `offload.landCheck`); its report, its fixes and its tree verdict come back here ([`sandbox.md`](sandbox.md#heavy-work-elsewhere)).
- **Pre-push**, [`verify-push.mjs`](../../_tools/scripts/verify/verify-push.mjs): the hook never runs the suite, and names the verdict recorded for the same tree when there is one. By hand, `pnpm verify:push` replays that verdict or leaves typecheck and test to CI; `--suite` runs them locally.
- **By hand, by a person**, `pnpm verify:turn` ([`verify-turn.mjs`](../../_tools/scripts/verify/verify-turn.mjs)): typecheck over the packages a branch's change reaches, and only the test files whose imports reach a changed file ([`turn-closure.mjs`](../../_tools/scripts/verify/turn-closure.mjs)), one step at a time, with [`failure-units.mjs`](../../_tools/scripts/verify/failure-units.mjs) setting aside failures main already had. It waits for the sandbox's heavy slot ([`heavy-slot.mjs`](../../_tools/scripts/lib/heavy-slot.mjs)). Nothing runs it automatically, and agents are told not to: they run the test files and package typecheck of what they changed.
- **CI**, [`.github/workflows`](../../.github/workflows): `ci.yml` builds and tests each affected area through `verify.yml`, runs the provider tier, re-runs a subset of suites under unusual time zones (`verify-clocks`), and runs the hermetic, billing and desktop tiers. `nightly.yml` runs `pnpm e2e`, onboarding and the desktop update tiers. Jobs run on self-hosted runners in the `ci-base` image.
- **Perf**, the `perf-instr` and `perf-browser` jobs in `ci.yml`: each publishes its counts against the baseline in [`_tools/perf/baselines`](../../_tools/perf/baselines) as the job summary, a report that never fails the job. What fails it is a declared budget, a one-directional claim with headroom such as "an idle clock tick redraws at most eight components" ([`browser/browser-budgets.ts`](../../_tools/perf/src/browser/browser-budgets.ts), [`instr/instr-budgets.ts`](../../_tools/perf/src/instr/instr-budgets.ts)). A baseline is re-recorded only by [`perf-record.yml`](../../.github/workflows/perf-record.yml), dispatched by hand on the CI runner class, which uploads the diff as a patch to commit with the change it describes.
- `pnpm test` fans out through `turbo run test --only`, with `TEST_WORKERS` and the task count sized to the memory free when it starts by [`test-workers.mjs`](../../_tools/scripts/verify/test-workers.mjs); `pnpm typecheck` sizes its task count the same way.
