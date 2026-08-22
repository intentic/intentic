# Why the pipeline goes red

> An audit of the ten most recent failed runs in `intentic/intentic`, 2026-08-20 to 2026-08-21, read from the
> job logs rather than from memory. Sibling of [`ci-audit.md`](ci-audit.md), which reviews the *shape* of
> `.github/`. This one asks a narrower question: when a run goes red, what actually broke, and would a cheaper
> check have said so first.
>
> Everything quoted below comes from a real log or a real commit. Run and job ids are given so any claim can
> be re-read at source.

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
  run: bash _tools/scripts/dispatch-publish.sh "$PLANNED_RELEASE_VERSION"
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

**What is still open.** The pattern was fixed in one file. **Five allow-list mocks of `@intentic/ui` remain**,
the same shape over a workspace package that changes at least as often:

```
_editor/web/src/chat/ChatMessageView.test.ts:36        _editor/web/src/chat/ChatForkCut.test.ts:32
_editor/web/src/agents/AgentDetail.test.ts:28          _editor/web/src/composables/workspace/useMonaco.test.ts:5
_editor/web/src/composables/agents/agentActions.test.ts:29
```

Only `WorkspaceSearchResults.test.ts` uses `importOriginal`. Each of the five is one new export away from being
this failure again.

**Fix.** Convert the five to spread-then-stub. Then make it a rule rather than five repairs: a whole-module
`vi.mock` of a *workspace* package must spread the original. That is mechanically checkable in prepass, and it
is the difference between fixing this incident and fixing this class.

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

### 1. Stop reporting a skipped release as a failure. Removes 30% of these failures

Gate the dispatch, the provenance attach and the version echo on "semantic-release actually released". A no-op
release is green. Make `dispatch-publish.sh` say what went wrong instead of surfacing `curl: (22)`.

*Effort: an hour. Payoff: 3 of 10.*

### 2. Move the two workflow-lint exceptions onto the steps they describe. Removes 20%

Inline `# zizmor: ignore[artipacked]` with the reason, delete the line-number pins. Keeps the guarantee that a
third credential-persisting checkout fails the lint, and stops unrelated edits from going red.

*Effort: fifteen minutes. Payoff: 2 of 10, plus every future recurrence.*

### 3. Finish the shared test-budget rollout, and make it the only option

Convert the 30 hold-out configs to `UNIT_SUITE` and `INTEGRATION_SUITE`, leaving `_editor/web` on its measured
ceilings. Then add a prepass invariant refusing a `vitest.config.ts` that spreads neither suite and offers no
written reason: the same shape as the existing invariants, and the thing that stops the eight-incident history
from reaching nine.

Separately, measure `turbo run test --concurrency=N` against the current full-width run. If wall clock is
neutral it removes the worker-start failures for free. If it is not, record the number beside the `maxWorkers`
measurement so nobody re-derives it.

*Effort: half a day of mechanical conversion plus one measurement. Payoff: the class with the longest history.*

### 4. Declare the "cheapest gate that can see it" rule, and hold new checks to it

Invariant 12 is the pattern. Write the rule where checks get added: **if a defect class is visible only to the
50-minute job, it gets a detector in the second-long one.** Audit the remaining bundled formats against it once.

*Effort: a page and one sweep. Payoff: prevents the five-hour outage shape.*

### 5. Convert the five remaining allow-list mocks, then make it a rule

The contract mock was fixed the right way an hour after it broke. Five `@intentic/ui` mocks of the same shape
are still armed. Convert them to spread-then-stub, then add the prepass check: a whole-module `vi.mock` of a
workspace package must spread the original.

*Effort: five files and one invariant. Payoff: 1 of 10, plus five loaded traps.*

### 6. Put the store shells on the nightly schedule

Four lifetime runs, three of them red. Keep the path filter for pushes and add the same two jobs to
`nightly.yml`, so generator drift surfaces on a schedule instead of on someone's unrelated push.

*Effort: twenty minutes. Payoff: moves generator drift off the critical path.*

### 7. The structural one: something has to read the code before CI does

The six fixes above address every failure in this window. None of them touch the reason those failures cost 90
minutes each instead of 90 seconds. **61% of runs on `main` are red, there are no pull requests, there is no
branch protection, and the pipeline is the first reader.**

Three options, cheapest first.

**(a) Make `pnpm verify` match what CI gates.** Today `verify` is `typecheck && test`. CI runs
`turbo run build test`. The Class A outage lived in precisely that gap: someone who ran `pnpm verify` and
pushed had done everything the repo asked and still broke `main` for five hours. Adding `build` to `verify` is
a one-line change that closes it.

**(b) Extend the pre-push hook to the affected closure.** The hook is deliberately install-free and about
70 ms, and that property is worth keeping for what it does today. A second, opt-out tier
(`turbo run typecheck build test --filter=...[origin/main]`) is nearly free with a warm turbo cache and catches
everything in classes A, B and E before the push. `--no-verify` remains the escape hatch it already is.

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
