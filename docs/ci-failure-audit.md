# Why the pipeline goes red

> An audit of the ten most recent failed runs in `intentic/intentic`, 2026-08-20 to 2026-08-21, read from the
> job logs rather than from memory. Sibling of [`ci-audit.md`](ci-audit.md), which reviews the *shape* of
> `.github/`. This one asks a narrower question: when a run goes red, what actually broke, and would a cheaper
> check have said so first.
>
> Everything quoted below comes from a real log or a real commit. Run and job ids are given so any claim can
> be re-read at source.

## Status

Six of the seven recommendations are applied. One is withdrawn for a reason the work turned up, and one is a
decision rather than a change.

**Applied:** 1, the release no longer reports a skipped release as a failure. 2, the workflow-lint exceptions
moved onto their steps. 3, all 41 packages now name a test budget, held by prepass invariant 13. 4, the rule is
stated and the template gate reaches the push. 6, the store shells run nightly. 7(b), the push gate now runs what
CI runs (`_tools/scripts/verify/verify-push.mjs`, from both the app's push check and the git hook); the note at 7(b)
records what a second hundred pipelines showed and why the gate is unfiltered rather than scoped.

**Applied after the second hundred (2026-09-02), on the loops that let the reds be written rather than merely
pushed:** test files get real per-edit diagnostics (`@intentic/lsp` checks them against `tsconfig.test.json`,
the program that compiles them, instead of the build config that excludes them); a shell-made edit gets the same
diagnostics as an Edit (`agent-shell-edits.ts`); the turn-ending check re-measures a repair instead of ending
on the SDK's re-entry flag; a red check holds the turn's work on its branch (`outcome: "checks-failed"`,
`turn-checks.ts`); the assertion ratchet refuses an undeclared weakening at the push and reports one at the Stop
(`assertion-ratchet.mjs`, the `verify-tests` rule); the push refuses a manifest committed without its lockfile;
prepass invariant 14 reads allow-list package mocks (Class B) against the imports of the code under test; mutation
testing is configured weekly over the daemon's steering hooks, `rules/` and the contract's chores, with one
vitest-scoping step still outstanding (`stryker.conf.mjs` says which); and
`_tools/scripts/ci/ci-audit.mjs` produces this document's table as a nightly job summary. Its first run found the
red of the day: three verify groups failing `prepass.mjs` with `@intentic/base/async has no exported member
'pollUntil'`, because fifteen emitted packages depended on `@intentic/base` or `@intentic/constants` without a
tsconfig `references` edge, so `tsgo -b` built them against the stale dist a persistent runner keeps. The edges
are added and prepass invariant 15 refuses the shape.

**Applied after the third hundred (2026-09-04), and the finding is that the rule at the top of this document had
an unstated premise.** "A class visible to the 60-minute job gets a detector in the seconds-long one" assumes the
seconds-long job can SEE the class. Read across 131 runs on main, **55% of every job-failure sits in a job no
local gate can run** — image builds, registry pushes, the Windows installer smoke test, a postgres service
container — and over the most recent 60 runs it is 76%. Tightening the push cannot move that half, which is why
tightening it kept feeling like the answer and kept not working. `ci-audit.mjs` now computes the split as a
`gate reach` column (`local` / `partial` / `ci-only`) and a line under the table, so the next argument about
which gate to build starts from what a gate could reach. Two things came out of the same read and are fixed:
the assertion ratchet's DOWNGRADE rule read absolute matcher counts with no sense of scale and refused a suite
that had grown by five tests and 247 characters of expectation, so it now also requires the file to have shed
asserted text (`assertion-measure.mjs`; over 400 commits the clause changes exactly one verdict, and that one
was wrong); and `queue-run.integration.test.ts`, the only test file still failing CI in September, waited fixed
durations for a process to start — a 5s rendezvous bound and a 400ms sleep before a slot was assumed held — so
both are now rendezvous with a 30s bound, one against a marker the held command itself writes.

**And one red that belonged to no run at all (2026-09-04).** Every agent turn's ending check was failing
`_tools/scripts/build/emit-declarations.mjs` with `TS6307: File '.../_platform/prisma/generated/client.ts' is not
listed within the file list of project`, on a file `prisma generate` had written seconds earlier and `stat`
could still open. The tsconfig was right and the codegen was right; the DIRECTORY was unreadable. Each turn
mounts `node_modules`, `dist` and `generated` as overlays whose lowerdir is the main checkout's copy, an
overlay resolves that lowerdir once at mount time, and `_platform/prisma`'s build script began `rm -rf
./generated`, so a `turbo run build` on the main tree gave that path a new inode and every live turn's merged
view of it went permanently empty — upper layer included. This document's own question ("would a cheaper check
have said so first") has a sharper form here, because the failing gate was not measuring the turn at all: a
gate that goes red for a reason no change caused teaches everyone reading it that red means nothing. The
build scripts now empty those directories instead of replacing them
(`_tools/scripts/build/clean-outputs.mjs`), `@intentic/constants/mirror-roots` holds the rule as one copy the
daemon's isolation and the gates share, and `_tools/checks/mirror-roots.mjs` refuses the shape anywhere a
shell command in the repository spells it.

**Withdrawn:** 5. The sweep it proposed is the wrong change, and Class B says why with the failing output.

**Left to the team:** 7(c), branch protection. It is a decision about how the repository is worked, not a code
change.

**Two findings arrived while the fixes were being made**, and both changed what got done:

- **Eleven more packages ran vitest with no config at all**, which the original count missed because it counted
  config files. Two of them were running `*.integration.test.ts` under the 5s hang detector. They are converted
  too, so recommendation 3 covers 41 packages rather than 30.
- **`pnpm verify` already caught Class A**, through the invariant 12 that landed hours after the outage, so
  recommendation 7(a) as written was unnecessary — and would have broken the main development path, because
  `pnpm build` dies EXDEV under agent worktree isolation. The real remaining gap was the pre-push hook, which
  could not reach that gate. That is what was fixed instead.

## The number that frames everything

Of the last 100 `CI` runs on `main`: **61 failed, 34 succeeded, 4 cancelled, 1 startup failure.** All 100 were
`push` events. Not one was a pull request. `main` carries no branch protection and no required status checks.

At roughly 60 commits a day against a 60-90 minute pipeline, **CI is the first thing in the project that reads
the code**, and it reads it an hour late, in batches of eight to ten commits. Every finding below is either a
consequence of that arrangement or made expensive by it.

The ten failures fall into **six classes**, and four of the six had happened before.

---

## The ten

| # | Run | When | Job(s) | Class |
|---|-----|------|--------|-------|
| 1 | [32500936673](https://github.com/intentic/intentic/actions/runs/32500936673) | 08-21 16:03 | verify-site, verify-platform | **B** allow-list mock |
| 2 | [32482679871](https://github.com/intentic/intentic/actions/runs/32482679871) | 08-21 12:36 | verify-site, -platform, -core | **A** bundler-only syntax error |
| 3 | [32480911097](https://github.com/intentic/intentic/actions/runs/32480911097) | 08-21 12:14 | verify-site, -platform, -core | **A** bundler-only syntax error |
| 4 | [32480910765](https://github.com/intentic/intentic/actions/runs/32480910765) | 08-21 12:14 | android, ios | **F** generated-shell drift |
| 5 | [32458072655](https://github.com/intentic/intentic/actions/runs/32458072655) | 08-21 07:18 | preflight | **C** line-pinned lint exception |
| 6 | [32429841119](https://github.com/intentic/intentic/actions/runs/32429841119) | 08-20 23:43 | preflight | **C** line-pinned lint exception |
| 7 | [32416207132](https://github.com/intentic/intentic/actions/runs/32416207132) | 08-20 20:49 | release / publish | **D** dispatch after a no-op release |
| 8 | [32414144429](https://github.com/intentic/intentic/actions/runs/32414144429) | 08-20 20:27 | release / publish | **D** dispatch after a no-op release |
| 9 | [32407940557](https://github.com/intentic/intentic/actions/runs/32407940557) | 08-20 19:18 | verify-core, verify-platform | **E** runner-contention flake |
| 10 | [32403477884](https://github.com/intentic/intentic/actions/runs/32403477884) | 08-20 18:29 | release / publish | **D** dispatch after a no-op release |

**By class:** D ×3, A ×2, C ×2, B ×1, E ×1, F ×1.

None of the ten was a product regression caught by a test. Every one was either a mechanical defect a cheaper
gate could have named, or the pipeline reporting its own bookkeeping as a failure.

---

## Class D: the release dispatches a tag that was never cut (3 of 10)

**What the log says.** `publish` runs `pnpm exec semantic-release`, which prints:

```
[semantic-release] › ℹ  The local branch main is behind the remote one, therefore a new version won't be published.
```

and exits 0. The very next step runs unconditionally:

```yaml
- name: Publish to npm and the GitHub Marketplace
  run: bash _tools/scripts/release/dispatch-publish.sh "$PLANNED_RELEASE_VERSION"
```

`PLANNED_RELEASE_VERSION` is `needs.plan.outputs.version`, computed by the `plan` job **77 minutes earlier**
(run 32416207132: plan at 20:50, publish at 22:07). No tag was pushed, so the dispatch asks GitHub to start a
workflow at `v1.223.0`, a ref that does not exist. GitHub answers **422**, `curl --fail` returns 22, the job
goes red.

**Why it repeats, and will keep repeating.** The race is the normal case, not a rare one. `publish` sits behind
`verify-core`, `ci-base`, `ci-desktop`, the Windows build and the arm64 sandbox. By the time it runs, an hour
of commits has landed on `main`. semantic-release is right to decline. The pipeline is wrong to call that a
failure.

The steps *after* the dispatch share the defect: `attach-provenance.sh` and the version echo below it also read
`PLANNED_RELEASE_VERSION` with no guard that a release happened.

**What it costs.** Three red runs in two days, each after 60-90 minutes of build. The noise is the smaller
half. A real publish failure now looks exactly like the routine one, so nobody reads either.

**Fix.** Have semantic-release report whether it released (its `success` exec hook fires only on a real
release; the tag's existence is the other signal), and gate the dispatch, the provenance attach and the version
echo on that. A skipped release is a normal, green outcome. Say so in the log and move on.

Second, smaller: `dispatch-publish.sh` should refuse an empty or unresolvable version in its own words rather
than letting a bare `curl: (22)` stand as the whole error message.

---

## Class A: a syntax error only the bundler can see (2 of 10)

**What the log says.**

```
[plugin vite:vue] _extensions/knowledge/src/KnowledgePane.vue:207:109
RolldownError: Error parsing JavaScript expression: Unterminated template. (1:2)
```

The line:

```vue
<span v-else :title="`No note for "${link.title}" yet`">
```

A double quote inside a backtick template inside a double-quoted attribute. `vue-tsc --noEmit` ran first, in
the same job, over a `tsconfig.json` whose `include` explicitly covers `./src/**/*.vue`, and said nothing.
Three thousand one hundred and forty-nine unit tests passed. Only the production bundle refused it.

**The timeline carries the finding.** The bad line landed at **09:57** in `bec7441f4`, a commit titled *"chore:
update all tsconfig.json files to reference latest TypeScript version"*. No CI run touched it until **12:14**.
It was fixed at **15:33** in `276ec1385` ("fix: skills"), a one-character change. **Five hours and thirty-six
minutes from break to green, three red pipelines, roughly four hours of runner time, for a stray quote.**

**Already partly fixed.** `a7c851310` added prepass invariant 12: compile every Vue template, since no type
checker reads them. That closes this exact hole.

**What is still open** is the general rule the incident points at. *Any defect class visible only to the
50-minute job needs a detector in the second-long job.* Invariant 12 covers Vue templates. Nothing covers the
equivalent for the other bundled formats, and nothing states the rule, so the next one gets caught by another
five-hour outage rather than by policy.

---

## Class C: a lint exception pinned to a line number (2 of 10)

**What the log says.** `preflight` runs `lint-workflows.sh`; zizmor reports one medium finding and exits 13:

```
warning[artipacked]: credential persistence through GitHub Actions artifacts
   --> .github/workflows/release.yml:385:9
138 findings (30 ignored, 107 suppressed, 1 unsafe fixes): 0 informational, 0 low, 1 medium, 0 high
```

`.github/zizmor.yml` suppresses this checkout **by line number**. Its own comment records the history:

> `# Was 349, then 358, now 385 — publish's checkout keeps sliding down as steps and env: land above it`

So this is at least the third occurrence. The two red runs here are the fourth and fifth: twenty-seven lines of
Windows signing config landed above the checkout, moved it, and the pipeline went red on a file nobody had
semantically changed.

**The design is deliberate, and worth respecting.** The comment states the intent plainly: line scoping means a
*third* credential-persisting checkout fails the lint, where a file-wide ignore would silently cover it. That
intent is right. The `artipacked` backlog was 34 findings, and quiet erosion is how it got there.

**But the intent does not require a red pipeline.** zizmor accepts an inline suppression as a YAML comment
anywhere inside the finding's span, with an explanation after the rule name:

```yaml
- uses: actions/checkout@… # zizmor: ignore[artipacked] semantic-release pushes the tag from this checkout
  with:
    fetch-depth: 0
    clean: false
```

The comment travels with the step when it moves, so unrelated edits above it cost nothing, and a newly added
checkout carrying no comment still fails the lint. Same guarantee, no bookkeeping red runs, and the reason now
sits on the step a reviewer already has open instead of in a distant config file.

**Recommendation.** Move both `artipacked` exceptions to inline comments and delete the line pins. Keep the
"no file-wide ignores" rule, which is the part actually holding the backlog at two.

---

## Class B: an allow-list mock of a package that keeps growing (1 of 10)

**What the log says.**

```
FAIL src/chat/ChatMessageView.test.ts
Error: [vitest] No "TOR_EXIT_COUNTRIES" export is defined on the "@intentic/sandbox-contract" mock.
      Did you forget to return it from "vi.mock"?
```

**The chain, to the minute.** At **15:33** `7d10e8bef` ("feat: vpn") added `TOR_EXIT_COUNTRIES` to
`_sandbox/sandbox-contract/src/schemas.ts`. The web app's `ChatMessageView.test.ts` mocked that package with a
**hand-written list of the five exports it happened to want**:

```ts
vi.mock("@intentic/sandbox-contract", async () => {
    const { GrantedRoleSchema, MemberRoleSchema, PushNotificationSchema, roleAtLeast, withoutResumeNote } =
        await vi.importActual<typeof import("@intentic/sandbox-contract")>("@intentic/sandbox-contract");
    return { planParts: (text) => ({ body: text }), GrantedRoleSchema, /* …the other four… */ };
});
```

The contract's vocabulary is evaluated at module load, so the new constant was demanded before a single test
ran. A VPN feature in one package took down a chat-transcript suite in another that had no interest in it.

**Already fixed, and fixed correctly.** At **16:09** `2faf74080` inverted the mock: spread the real module,
stub the one part the test actually wants.

```ts
vi.mock("@intentic/sandbox-contract", async (importActual) => ({
    ...(await importActual<typeof import("@intentic/sandbox-contract")>()),
    planParts: (text: string) => ({ body: text }),
}));
```

Its comment names the disease exactly: *"that list was a tripwire… every addition to it took this suite down
with 'no such export on the mock' long before any test ran."* `verify.yml` had already written down the same
lesson from a different angle: *"hand-built fakes drifted out of shape with the seams they stand in for."*

**What is NOT open, having been checked.** Five other allow-list mocks of `@intentic/ui` look like the same
shape (`ChatMessageView.test.ts:36`, `ChatForkCut.test.ts:32`, `AgentDetail.test.ts:28`, `useMonaco.test.ts:5`,
`agentActions.test.ts:29`). Converting them to spread-then-stub was the obvious next sweep, and it is wrong.
Tried on the smallest of them, it fails before a test runs:

```
Caused by: ReferenceError: document is not defined
 ❯ read ../ui/src/composables/useTheme.ts:33:5
 ❯ ../ui/src/components/MermaidDiagram.vue:22:1
```

`@intentic/ui` is a Vue component graph whose module scope touches the DOM, and these suites run under
`environment: "node"`. The one suite that does spread it, `WorkspaceSearchResults.test.ts`, opens with
`// @vitest-environment jsdom` and pays for it. Spreading the rest would mean jsdom everywhere, which the web
package's own measurements price at ~45-60s of setup — the Class E pressure, bought back to prevent a Class B
that cannot happen here anyway. A mock that REPLACES a module outright is never asked for its missing exports,
because nothing loads the original.

So the two cases differ in the one way that matters. `sandbox-contract` is loaded by the graph regardless (its
vocabulary is evaluated at import), so the mock had to track it and an allow-list was a tripwire. `@intentic/ui`
is fully substituted, and the allow-list is the only form that works. **There is no sweep to do, and no
prepass rule to write** — a blanket "must spread the original" would demand exactly the change that breaks
these five.

---

## Class E: the runner is oversubscribed and the timeouts report it as flakiness (1 of 10)

Two symptoms, one run, one cause.

**Symptom 1**, `verify-core`, `_search/iq`:

```
FAIL src/cli.test.ts > bare query routes to q (defaultCommand)
Error: Test timed out in 5000ms.
```

**Symptom 2**, `verify-platform`, `_editor/web`, after 297 files and 3,111 tests **passed**:

```
Error: [vitest-pool]: Failed to start forks worker for test files .../shikiLangs.test.ts
Caused by: Error: [vitest-pool-runner]: Timeout waiting for worker to respond
```

**This class has the longest history in the repository.** `_tools/testing/src/vitest.ts` names six prior
victims by hand: *"iq-engine's warm pass, the chat-tabs mount, the daemon's fire routes"* and *"app.integration's
TURN_SETTLES, turn-resume's READ_BACK and prepush's inline 5s"*, each repaired with its own private constant
*after* it had already broken `main`. `_editor/web/vitest.config.ts` carries a 40-line measured analysis of the
same problem. The shared `UNIT_SUITE`, `INTEGRATION_SUITE` and `SETTLES` budgets are the right answer, and
`_search/iq` adopted them, citing this very failure in its config.

**The gap is adoption. 31 of 52 vitest configs still do not use the shared budgets.** One of the 31,
`_editor/web`, is a deliberate exception with its own measured 20s/30s ceilings and the analysis to justify
them. The other 30 are not exceptions. They run on vitest's bare 5s hang detector with no statement of intent,
and most also narrow `include` to `./src/**/*.test.ts`, the exact glob the shared module warns will silently
stop running tests that live anywhere else:

```
_platform/api, capability-catalog, example-provider
_deploy/engine, graph, need-resolver, sdk, state-resolver
_sandbox/registry, sandbox-contract, sandbox-openapi, webchat-widget, workspace-ignore, workspace-setup
_extensions/ ×12, _editor/desktop-app, share-view, _search/iq-bench, _tools/base
```

Each is a future symptom 1 waiting for a loaded runner.

**Symptom 2 is not fixable by a budget.** `START_TIMEOUT` is a hard-coded 60 s constant inside vitest 4 with no
config surface. A fork failed to answer within a minute because turbo was running every package's vitest at
once on a box carrying six runner processes. The web config records that capping *vitest's* `maxWorkers` made
the whole repo **2.5× slower**, so that lever is closed. Capping **turbo's** concurrency for the `test` task is
a different lever and has not been measured. That is a one-line experiment worth running before anything more
elaborate.

---

## Class F: the store shells drift while nobody is looking (1 of 10)

**Android:**

```
_editor/android-app/app/build.gradle line: 44: Unexpected input: ',' @ line 44, column 34.
   splashScreenFadeOutDuration: ,
```

Bubblewrap generated `build.gradle` from `twa-manifest.json`, which had no `splashScreenFadeOutDuration` key.
An absent field became an empty value became a Groovy syntax error. Fixed by adding the field.

**iOS:**

```
xcodebuild: error: 'ios/App/App.xcworkspace' does not exist.
```

Capacitor wires its dependencies as a Swift package when every plugin ships a `Package.swift`. That path never
runs CocoaPods, so no workspace is written. Both `mobile.yml` and `mobile-release.yml` were asking for one.
Fixed by switching to `-project`, in both files, with a good comment.

**Why it fired now, and the number that makes the point.** `mobile.yml` has run **four times in its life**:

```
08-20 12:36  failure    08-20 13:32  failure    08-21 12:14  failure    08-21 12:36  success
```

It triggers only on `_editor/ios-app/**`, `_editor/android-app/**`, its own file, and the SDK script. That
filter is right for cost, since the shells are thin config over the hosted web app and both toolchains are
pinned (`@bubblewrap/cli@1.25.0`, `@capacitor/cli@8.5.0`). But it also meant the shells stayed broken from
their first run to their fourth, a full day, with nothing to say so in between because nothing ran. Neither
defect was a product change. Both were generators wanting something the checked-in config did not say.

A validation job that runs four times a year does not gate anything; it reports the fire after it started.

**Fix.** Add both shell builds to `nightly.yml`, which already exists for exactly this ("the deep verification
tiers, on a schedule rather than per-push"). Drift then surfaces on a schedule, against nobody's push, and the
path filter keeps doing its job for cost.

---

## What to change

Ranked by runs removed over effort.

### 1. Stop reporting a skipped release as a failure — done, removes 30% of these failures

Gate the dispatch, the provenance attach and the version echo on "semantic-release actually released". A no-op
release is green. Make `dispatch-publish.sh` say what went wrong instead of surfacing `curl: (22)`.

*Effort: an hour. Payoff: 3 of 10.*

### 2. Move the two workflow-lint exceptions onto the steps they describe — done, removes 20%

Inline `# zizmor: ignore[artipacked]` with the reason, delete the line-number pins. Keeps the guarantee that a
third credential-persisting checkout fails the lint, and stops unrelated edits from going red.

*Effort: fifteen minutes. Payoff: 2 of 10, plus every future recurrence.*

### 3. Finish the shared test-budget rollout, and make it the only option — done, and wider than planned

**41 packages converted**, not the 30 the count above predicted: eleven more ran `vitest run` with no config
file at all, so they never appeared in a survey of configs. `_computers/local-agent` and `_computers/host` were
running `*.integration.test.ts` files — real git, real subprocesses — under the 5s detector, and had simply not
lost the race yet. `_editor/web` keeps its own measured 20s/30s ceilings.

**Prepass invariant 13** now refuses any package that runs vitest and names no ceiling: it must spread
`UNIT_SUITE`/`INTEGRATION_SUITE`, or state a `testTimeout` of its own. Verified both ways — it fires on a
reverted config and on a deleted one, and the whole suite passes with it green.

**The concurrency measurement was attempted and is not reported**, because no honest number came out of this
sandbox: an unrelated full-repo run was in flight for part of it, and the box is 16 cores against a fleet of
six runner processes on different hardware. It should be run where it matters. What the attempt *did* produce
is a live reproduction of the class: at `concurrency: "200%"` under load, two `_extensions/deployments` **unit**
tests failed the 5s ceiling after 15s and 18s of wall clock. Turbo's 200% is 32 concurrent tasks on 16 cores,
each starting its own vitest pool, and the shared budgets do not save a unit test from that. The web config
already measured that capping *vitest's* `maxWorkers` costs 2.5×; capping *turbo's* task concurrency is the
untested lever, and it is the one worth a fleet measurement.

### 4. Declare the "cheapest gate that can see it" rule, and hold new checks to it — done, plus the gap it exposed

The rule is now stated in the prepass header: **if a defect class is visible only to the 50-minute job, it gets
a detector in the second-long one.**

Holding invariant 12 to its own rule found that it did not meet it. The template compiler comes from
node_modules, so the gate sat below the `--checks-only` line and **the pre-push hook never reached it** — the
check that exists because of a five-hour outage was missing from the last thing standing between that outage
and `main`. It now runs there, and says so and carries on where the compiler cannot be resolved (the CI
preflight job, which runs before its install; the verify groups read every template minutes later regardless).

Verified end to end: reinstating the original broken quote makes `bash .githooks/pre-push` exit 1 naming
`KnowledgePane.vue:207:109` with the bundler's own message, and hiding `vue/compiler-sfc` makes the same hook
print what it skipped and exit 0.

### 5. Nothing to do — checked, and the obvious sweep is the wrong change

The contract mock was fixed the right way an hour after it broke. The five `@intentic/ui` mocks that look like
the same shape are not: the real barrel cannot load under `environment: "node"`, and substituting it outright
is what makes these suites cheap. Class B above has the failing output and the reasoning.

*Effort: none. Recorded so the sweep is not proposed again.*

### 6. Put the store shells on the nightly schedule — done

Four lifetime runs, three of them red. Keep the path filter for pushes and add the same two jobs to
`nightly.yml`, so generator drift surfaces on a schedule instead of on someone's unrelated push.

*Effort: twenty minutes. Payoff: moves generator drift off the critical path.*

### 7. The structural one: something has to read the code before CI does

The six fixes above address every failure in this window. None of them touch the reason those failures cost 90
minutes each instead of 90 seconds. **61% of runs on `main` are red, there are no pull requests, there is no
branch protection, and the pipeline is the first reader.**

Three options, cheapest first.

**(a) ~~Make `pnpm verify` match what CI gates.~~ Withdrawn: it already does, and the change would break the
worktrees.** `verify` is `typecheck && test` where CI runs `turbo run build test`, and the Class A outage
looked like it lived in exactly that gap. It does not, twice over. Invariant 12 closed it hours after the
outage: reinstating the broken quote fails `pnpm verify` today, at the right line. And adding `build` would
have been actively harmful, because `pnpm build` dies EXDEV under agent worktree isolation — which is why
`verify` was written without it, and is documented in three places. The gap that was real is the pre-push
hook's, and recommendation 4 closed it.

**(b) ~~Extend the pre-push hook to the affected closure.~~ Applied, unfiltered, after a second hundred
pipelines said what the first did not.** Of the 100 `main` runs to 2026-09-01: 55 failed, 24 succeeded, 21
cancelled. The reds of the last three days were type errors in `@intentic/ui` and `@intentic/ingress`, a test
file that did not compile, an adapter test whose fake had drifted, and `_sandbox/ic` failing `cargo fmt
--check` three pipelines running. Every one had passed the push check of the day, because that check was
`pnpm test`: tests only, on a tree CI then type-checked first, and a test file with a type error runs fine under
vitest. The git hook behind it ran only the ~70ms invariants, so a push from a terminal was measured by nothing.

`_tools/scripts/verify/verify-push.mjs` is now what both run. It executes verify.yml's three steps (`prepass`,
`turbo run typecheck`, `turbo run build test`) on the whole graph, with turbo's cache as the filter rather than
a `--filter=...[origin/main]` this file would have to keep in step with `affected.mjs`; runs `cargo fmt
--check` on any crate the push touches (rustfmt is on the image, clippy is not runnable there); and records the
verdict against a hash of the working tree so the app's check and the hook do not measure one tree twice. What it
cannot do is measure the commit rather than the tree: it says how many uncommitted paths it saw, and the rest is
the pusher's.

**(c) Branch protection with the three verify groups as required checks.** The real fix, and the one this
workflow layout was built for: `ci-audit.md` explains that the three groups exist as separately nameable
results precisely so they can gate independently. It costs the direct-to-`main` habit, which at 60 commits a
day is a genuine trade and the team's call.

*(a) should happen regardless. (b) is the high-value middle. (c) is the decision worth making deliberately.*

---

## What is already right

Worth saying, because the list above should not read as a verdict on the pipeline.

- **The three-way verify split** does what its header claims. In every multi-job failure here, the red groups
  were red for the same real reason and no group blocked another's artifacts.
- **The shared test budgets** are the correct answer to Class E, well reasoned and measured. The problem is
  that 60% of packages have not adopted them, not that they are wrong.
- **The prepass invariant mechanism** is the right machine for Class A, and invariant 12 landed within hours of
  the incident. The rule just needs stating, so it applies before the next outage rather than after it.
- **The Class B repair inverted the mock instead of patching it**, spreading the real module and stubbing the
  one part the test owns. That ends the class rather than the instance. Five files still need it.
- **The comments.** Nearly every fix in this window landed with a paragraph explaining what was learned, which
  is why this audit could be read off the repository instead of guessed at.

The pipeline is not fragile. It is being asked to be the first reader of every commit, and no 90-minute
pipeline does that job well.
