# @intentic/testing

The test-support seams every package's suites share: deep, self-naming stand-ins for wide interfaces.

## Responsibilities

- Provide the fakes that stand in for wide interfaces, so a suite does not hand-roll a fifth one.
- Provide the bun test harness every package runs on, and the e2e gate.

## Key files

- [src/index.ts](src/index.ts): the stand-ins.
- [bin/suites.mjs](bin/suites.mjs): every package's `test` script — two `bun test` runs, the unit hang detector and
  the integration budget, each reading the package's own bunfig.toml.
- [src/bun-preload.ts](src/bun-preload.ts): loaded per file through bunfig.toml — the budget by suite name.
- [src/bun.ts](src/bun.ts): the `vi.*` surface bun:test lacks — `waitFor`, `stubGlobal`/`stubEnv`,
  `advanceTimersByTimeAsync`, `freshImport`.
- [src/dom.ts](src/dom.ts): a jsdom window as globals, for the suite that imports it first.
- [src/bun-vue.ts](src/bun-vue.ts): the `.vue` loader, so a component test mounts the real SFC.
- [src/e2e.ts](src/e2e.ts): the opt-in gate `*.e2e.test.ts` suites sit behind.
- [src/stripe-fake.ts](src/stripe-fake.ts): a Stripe that speaks Stripe's own form encoding, over real HTTP.
- [src/fly-fake.ts](src/fly-fake.ts): a Fly Machines API that remembers what it was told, over `fetch`.

## How it fits

Imported by suites across the monorepo. It ships no production code and nothing depends on it at runtime.

## Conventions & gotchas

- **Self-naming.** A stand-in reports what it is when an assertion fails, because the alternative: a bare
  `undefined is not a function` five frames deep: is how an afternoon disappears.
- Deep rather than shallow: it stands in for the whole interface, so a suite does not have to know which three
  methods the code under test happens to call today.
- **A provider fake models the provider's RULES, not its replies.** `fly-fake` refuses a fork smaller than its
  source, refuses a restore from a snapshot that has not finished, and remembers which machine is running, because
  those are the constraints the code under test is written around and a per-request stub cannot express any of
  them. It answers an unrouted path with a loud 404 rather than `{ ok: true }`: a fake that answers everything
  hides the call you got wrong. Both provider fakes have suites of their own, since a fixture with rules in it is
  only as right as the rules.
- **A suite keeps its own stub when the seam is a different one.** `hosted-health` also probes the edge,
  `hosted-abuse` also reads Prometheus, and `fly.test.ts` is the client these fakes are built on — none of those is
  the Machines API alone, and pressing them through one fake would make it a fake of three things.
