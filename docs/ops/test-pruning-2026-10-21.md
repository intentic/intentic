# Test pruning review — 2026-10-21

Remove tests whose failure does not provide convincing evidence of a product regression.

## Evidence and scope

The review inventoried the repository test files and examined source-reading guards, small presentation tests, prompt text assertions, timing assertions, file histories, and the shared flake ledger. Each removal below was read before being selected. This is not a claim that every retained test has caught a regression.

For the question **“Has this ever failed in a way that indicated an actual regression?”**, the answer for every removed test below is **not demonstrated in the available record**. The available file histories and recent flake ledger do not establish such a failure. That is an unknown, not proof that a test has never failed. Comments describing the bug that motivated a test do not establish that the test subsequently detected a regression. None of these removal candidates appeared in the recent ledger.

Removal also requires a concrete weakness: checking source spelling instead of behavior, copying presentation data, testing only a third-party dependency, duplicating retained behavior tests, or measuring host-dependent latency. The reasons below apply individually to every listed declaration. Parameterized declarations are listed once, without inventing an expanded case count.

## Decisions

Security and compatibility checks remain, including deployed sign-in and microphone headers, state registry coverage, cross-language golden files, schema conformance, and the setup-code end-of-flags boundary. Checkout-feed, process-cancellation and stale-screencast behavior tests were not removed solely for appearing in the flake ledger: their assertions can expose real broken behavior. The dependency set, production code and test runner are unchanged.

### `_editor/web/src/viewWait.guard.test.ts`

**Decision:** Remove the suite. Regex convention scan; counts files and names of wait helpers rather than exercising ready/failed views.

**Historical answer for each test:** Not demonstrated.

- the guard is actually looking at the editor and the in-repo extensions
- no view wires its own wait
- no read counts its failure as its answer
- the failure-as-answer pattern is the one the read models had

**Available file history:** `dc51096a61 refactor(progress): replace WaitProgress with shared components/progress`; `075cfa8637 feat!: stop limitMoving, limitNextAt and limitScheduled in agent wire schemas`.

### `_editor/web/src/viewWork.guard.test.ts`

**Decision:** Remove the suite. Regex and indentation determine lifetime; never navigates away during pending work.

**Historical answer for each test:** Not demonstrated.

- the guard is actually looking at the editor
- work a person starts is kept beyond the view that started it

**Available file history:** `420a2d7980 refactor(web): migrate editor features to workbench useOperation and operations`.

### `_editor/web/src/moduleState.guard.test.ts`

**Decision:** Remove the suite. Indentation and helper-name scan, not a sandbox-switch isolation test.

**Historical answer for each test:** Not demonstrated.

- the guard is actually looking at the editor
- module-level reactive state is declared through the sandbox scope, or marked app-wide
- every app-wide pragma sits on module-level reactive state

**Available file history:** `cdd21d419c feat(gemini): add GeminiCatalog.select using googleModelAvailability from cliProxy`.

### `_editor/web/src/extension-host/tests/sandboxScope.guard.test.ts`

**Decision:** Remove the suite. Hand-written import walker and column-zero regexes do not execute a sandbox switch or timer cleanup.

**Historical answer for each test:** Not demonstrated.

- the guard is actually looking at the extensions
- module-level reactive state in an extension is declared through sandboxRef
- an extension keeps no reassignable module-level binding
- an extension does not run its own repeating clock

**Available file history:** `cdd21d419c feat(gemini): add GeminiCatalog.select using googleModelAvailability from cliProxy`.

### `_editor/web/src/client/sandbox/tests/useMembers.guard.test.ts`

**Decision:** Remove the suite. Checks file ownership and spelling of imports/routes, not whether a membership change reaches consumers.

**Historical answer for each test:** Not demonstrated.

- scans the app: a moved directory would otherwise read as a pass
- `is not reached for ${what} outside its module`

**Available file history:** `4ea80c217c refactor!: drop GrantRevokeSchema properties from the wire contract`.

### `_editor/web/src/lib/tests/queryKeys.guard.test.ts`

**Decision:** Remove the suite. Hand-written source parser and file-count floors enforce registry conventions without exercising cache invalidation.

**Historical answer for each test:** Not demonstrated.

- scans the whole app
- keeps every cache key out of inline literals
- keeps the scoping rule inside the registry
- keeps every exemption real
- gives every name the daemon can push a family or a contract read to land on
- scans every extension
- keys every extension's contract read by its procedure
- sees a hand-keyed read where there is one

**Available file history:** `3b22a8b9e9 refactor(sandbox): restructure codebase layers and module paths`; `2eb00e75bf feat: unification`; `cdd21d419c feat(gemini): add GeminiCatalog.select using googleModelAvailability from cliProxy`.

### `_editor/web/src/app/hoverFade.test.ts`

**Decision:** Remove the suite. Scans utility class strings across packages; does not observe a transition or its duration.

**Historical answer for each test:** Not demonstrated.

- never narrows a hover-coloured element's transition away from its colours, nor times it apart

**Available file history:** `54335eabc0 style(motion): unify hover fills on --motion-hover with base hover:bg-* rule`.

### `_editor/web/src/design-system/icons/iconDependencies.integration.test.ts`

**Decision:** Remove the suite. Dependency naming policy over lockfile text; no application behavior under test.

**Historical answer for each test:** Not demonstrated.

- keeps third-party icon packages out of the whole resolved dependency graph

**Available file history:** `cdd21d419c feat(gemini): add GeminiCatalog.select using googleModelAvailability from cliProxy`.

### `_editor/web/src/design-system/templateRefNull.test.ts`

**Decision:** Remove the suite. Tests Vue itself with a synthetic component, importing no application code or affected null guards.

**Historical answer for each test:** Not demonstrated.

- Vue clears a template ref to null, not undefined, when its element unmounts

**Available file history:** `cdd21d419c feat(gemini): add GeminiCatalog.select using googleModelAvailability from cliProxy`.

### `_sandbox/sandbox/src/bootstrap/boot-order.test.ts`

**Decision:** Remove the suite. Pins exact source fragments and step names; never boots the daemon or observes the gate.

**Historical answer for each test:** Not demonstrated.

- opens the gate before starting the apps, never behind them
- observes the starter's readiness rather than waiting on it
- sweeps stale sessions before anything that starts a process of its own
- makes the project folder a repo after the root repo and before the git dirs converge, and notes it before the baseline
- settles the version commits a restart cut once the fleet is loaded, before the gate opens
- reads the work a restart cut after the boot chain and before the gate opens
- seeds no starter site beside a project folder

**Available file history:** `bc6019e58 feat(local): show setup progress on LocalSetupCard`; `075cfa863 feat!: stop limitMoving, limitNextAt and limitScheduled in agent wire schemas`; `fd3630303 feat(sandbox): add inbox-store, kept-job-records and turn-resume recovery on boot`; `b21240346 feat(desktop): attach folders to machine sandboxes and deliver landed work`; `cdd21d419 feat(gemini): add GeminiCatalog.select using googleModelAvailability from cliProxy`.

### `_sandbox/sandbox/src/bootstrap/boot-shutdown.test.ts`

**Decision:** Remove the suite. Pins source names and setInterval spelling; never sends a signal or verifies teardown.

**Historical answer for each test:** Not demonstrated.

- tears down by disposing the store, never by naming subsystems
- starts no raw interval in any boot phase

**Available file history:** `4ea80c217c refactor!: drop GrantRevokeSchema properties from the wire contract`; `01572c8c8b refactor: simplify sandbox internals and strengthen lifecycle handling`; `cdd21d419c feat(gemini): add GeminiCatalog.select using googleModelAvailability from cliProxy`.

### `_sandbox/fileq/src/lib/derivers/load-cost.test.ts`

**Decision:** Remove the suite. Counts exact import spellings rather than measuring loaded modules; renaming or factoring a loader breaks it.

**Historical answer for each test:** Not demonstrated.

- keeps the heavy parsers out of every run that does not use them
- still loads each of them where its own format is parsed

**Available file history:** `cdd21d419c feat(gemini): add GeminiCatalog.select using googleModelAvailability from cliProxy`.

### `_tools/agent-cli/src/run.test.ts`

**Decision:** Remove the suite. Regex enforces an import style; never runs a CLI with a broken dependency.

**Historical answer for each test:** Not demonstrated.

- run.ts has no runtime import: a broken module graph must fail inside its own catch

**Available file history:** `cdd21d419c feat(gemini): add GeminiCatalog.select using googleModelAvailability from cliProxy`.

### `_sandbox/agent-context/src/field-notes-prompt.test.ts`

**Decision:** Remove the suite. Copies prompt prose verbatim; says nothing about emitted field notes being valid, ranked, or within budget.

**Historical answer for each test:** Not demonstrated.

- names the file, the place and the reader it was given
- spells out the shape field-notes.ts slices by rank
- tells the writer the budget is shared and a long section silences the ranks below it

**Available file history:** `fcf9970ffa feat!: drop leanGuidance and expand workspace maps and iq search`; `cdd21d419c feat(gemini): add GeminiCatalog.select using googleModelAvailability from cliProxy`.

### `_editor/desktop-app/src/osName.test.ts`

**Decision:** Remove the suite. Duplicates a static platform-to-label lookup table.

**Historical answer for each test:** Not demonstrated.

- names each platform the machine agent reports by its product name, and an unknown one as it came

**Available file history:** `c907c2e8f3 feat(desktop): add cli_path install of intentic onto PATH and a Windows setup sidebar`.

### `_editor/web/src/features/chat/models/catalog.test.ts`

**Decision:** Remove the suite. Duplicates CSS classes from a static presentation lookup and rechecks those same literals for animation.

**Historical answer for each test:** Not demonstrated.

- colours the title without animating it: the spinner beside it already says "running"
- never animates in any state
- gives each state its own colour, so the glyph is never the only difference

**Available file history:** `b41fa9441a feat(ui): add accent ink and semantic tints, map primary tone to text-accent`; `cdd21d419c feat(gemini): add GeminiCatalog.select using googleModelAvailability from cliProxy`.

### `_sandbox/sandbox/src/agent/pages/page-check.integration.test.ts`

**Decision:** Remove only the listed tests. Host-load-sensitive 1.1-second warm-browser benchmark; the remaining cases assert layout, console/error capture, frame sizing and height settling.

**Historical answer for each test:** Not demonstrated.

- answers a settled page well inside the old fixed 1.1s of waiting, once its browser is warm

**Available file history:** `71790d7367 fix(sandbox): stop paused children and waits stalling across restarts`; `d0c5bbc594 feat(pages): tell the agent when a shown page's scripts throw`; `95f22892ff feat(chat): show interactive pages and collect answers in chat`.

### `_sandbox/sandbox/src/conversations/sandbox-run-contract.test.ts`

**Decision:** Remove only the listed tests. Repository-wide source/import spelling scan and hard-coded caller roster; do not compose or execute the run contract. The concrete setup-code flag boundary stays.

**Historical answer for each test:** Not demonstrated.

- no file in the repo hand-rolls a sandbox container run: TS composes from the contract, scripts use the verb
- every creation flow still speaks the contract: the positive floor under the discovery above

**Available file history:** `fc1c6fad9e test(sandbox): stub modelCooldowns and narrow STARTS_CONTAINER to docker run`; `e746352e31 chore: drop keptForDays locale keys and fix tests after sealed requests`; `cdd21d419c feat(gemini): add GeminiCatalog.select using googleModelAvailability from cliProxy`.

### `_editor/web/src/bootProfile.test.ts`

**Decision:** Remove only the listed tests. Searches inline JS for literal cookie/URL/storage spellings already exercised by the shipped-script behavior tests below.

**Historical answer for each test:** Not demonstrated.

- reads the param and writes the record under the names everything else uses
- reads the site's edition cookie by the name the site writes it under

**Available file history:** `d58c7abb1a feat(editor): replace Bubblewrap TWA with native android-app on mobile-core`; `3b22a8b9e9 refactor(sandbox): restructure codebase layers and module paths`; `cdd21d419c feat(gemini): add GeminiCatalog.select using googleModelAvailability from cliProxy`.

### `_editor/web/src/bootLocale.test.ts`

**Decision:** Remove only the listed tests. Searches inline JS for one storage read already exercised by the stored-choice and obsolete-language cases.

**Historical answer for each test:** Not demonstrated.

- reads the choice from the key the preference writes it to

**Available file history:** `3b22a8b9e9 refactor(sandbox): restructure codebase layers and module paths`; `cdd21d419c feat(gemini): add GeminiCatalog.select using googleModelAvailability from cliProxy`.

### `_sandbox/webchat-widget/src/styles.test.ts`

**Decision:** Remove only the listed tests. Copies palette values and exact CSS formatting; no rendering or contrast contract. Contrast, fallback and variable parity cases stay.

**Historical answer for each test:** Not demonstrated.

- the dark bubbles are the app's two chat surfaces, not a flat panel and a block of accent
- the accent is stepped per scheme, landing beside the ramp steps the app uses for ink

**Available file history:** `3b22a8b9e9 refactor(sandbox): restructure codebase layers and module paths`; `4772498b7f feat(analytics): add analyticsConsent, AnalyticsConsent and SandboxAnalytics for opt-in analytics`; `cdd21d419c feat(gemini): add GeminiCatalog.select using googleModelAvailability from cliProxy`.

### `_sandbox/sandbox/src/runtimes/codex/codex-instructions.test.ts`

**Decision:** Remove only the listed tests. Copies one configuration constant; never starts a thread or observes duplicated project instructions.

**Historical answer for each test:** Not demonstrated.

- Codex's own AGENTS.md loader is given no budget

**Available file history:** `d0ece8202f feat(chat): add LoopChips, LoopTermsRow, and offeredLoops for per-provider loop choice`.

### `_sandbox/claude-plugin/src/manifest.test.ts`

**Decision:** Remove only the listed tests. Pins README table formatting, not plugin behavior or published artifact validity.

**Historical answer for each test:** Not demonstrated.

- the README documents every switch

**Available file history:** `46ac3326de feat(sandbox): wire plugin-modules and agent-ui behind intentic-guard with hookSet approvals`; `cdd21d419c feat(gemini): add GeminiCatalog.select using googleModelAvailability from cliProxy`.

## Verification

The remaining affected suites and adjacent behavior tests passed with one worker per run:

| Package | Tests passed | Coverage checked |
| --- | ---: | --- |
| `@intentic/web` | 128 | Shipped boot scripts, membership updates, operation lifetimes, query key shapes, push invalidation, sandbox scope disposal and polling across switches |
| `@intentic/sandbox` | 22 | Boot lifecycle and sweeps, setup-code boundary, Codex instructions and real Chromium page layout |
| `@intentic/claude-plugin` | 5 | Manifest generation, configuration and shipped executable/module declarations |
| `@intentic/webchat-widget` | 4 | Accent contrast, unsupported CSS, fallback and scheme variable parity |
| `@intentic/agent-context` | 8 | Field-note parsing, ranking and budgets |
| `@intentic/fileq` | 9 | DOCX derivation and PDF furniture filtering |
| `@intentic/agent-cli` | 9 | CLI output capture, exit codes, output formats and flags |
| `@intentic/extension-api` | 10 | Permission checks, event streams, stored-data conversions and backend module lifecycle |

That is 195 passing tests across 24 retained files. Oxlint reported no warnings or errors in the seven edited test
files. Scoped repository checks, the test-program coverage/budget/reference check, and `git diff --check` passed.
No production code, exported types, dependencies or runner configuration changed.
