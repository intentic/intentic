# CI/CD architecture review

> An outside read of `.github/` as it stands at `0e5505c17` (2026-08-16). Sibling of
> [`ci-runner.md`](ci-runner.md), which documents the runners this criticises.
>
> **Since this review:** the VSCode extension and its `vscode-publish.yml` were removed from the
> repository. Quotes below are left as they stood (this is a snapshot, not a living page) so
> anywhere the text names that workflow, read it as one of the two publish workflows of the day.
>
> Scope: 10 workflows + 1 composite action in `intentic/intentic` (~2,200 lines of YAML), the
> `_tools/scripts/` layer they drive, and `registry`'s single workflow. Durations quoted as
> "budget" are `timeout-minutes`, not measurements: where a real measurement exists it is
> attributed to the file that recorded it.

## Status

Nine of the ten recommendations are applied. Each finding below carries its own status line;
the table at the end is the summary.

**Applied:** A1 (the unfireable trigger, plus prepass invariant 10 for the class) · A2 (the
`dind-host` tag skew) · A3 (the path filters, now computed from the dependency graph) · B1
(the Windows smoke tier, three copies → one) · B2 (the workspace-survival allowlist) · B3
(`actionlint` + `zizmor` gating in `preflight`, and the whole `artipacked` backlog) · B4
(`registry`'s pins) · C1 (the duplicate desktop build) · part of §D.

**Still open:** A1's structural half (tagging with a GitHub App token, which needs a credential
only a maintainer can create) · the desktop-container half of B1 · C2/C3 (the runner topology,
which is a provisioning decision rather than a code change).

**A3 found a live defect while it was being replaced.** The regexes claimed `_editor` held no
dependency of any image-bound package. It was false: the three extensions baked into the
sandbox image depend on `@intentic/extension-ui`, which re-exports `@intentic/ui` out of
`_editor/ui`: so every UI-kit change had been skipping the image rebuild, silently, for as long
as the filter has existed.

---

## Verdict

**This is a good pipeline with an abstraction problem, not a bad pipeline.**

The hard parts are right, and right for stated, measured reasons: the verify split is
correctly motivated, the shared-cache decision beat the alternative on numbers, the fork
boundary is a genuine two-control design, and the supply-chain posture (digest-pinned
actions, provenance attestation, CodeQL, Scorecard, tokenless npm publishing) is better than
most funded teams ship. Very little here is cargo-culted; nearly every line has an incident
attached to it.

The problem is that **the pipeline has outgrown the only abstraction GitHub Actions gives
it.** Actions has no anchors, no includes, no job templates worth the name: so a design this
detailed expresses itself as 2,200 lines of near-duplicate YAML plus ~4,700 lines of shell
plus an 862-line home-grown static analyser that parses YAML with a line scanner. Each of
those three layers is individually defensible. Together they are a second codebase, changed
roughly once a day (34 commits to `ci.yml` in five weeks), with no type system, no tests
worth the name, and a feedback loop measured in pipeline-hours.

That shows up as a specific, repeating failure signature: **silent no-ops.** A trigger that
can never fire. A path filter that stopped matching a directory. An image tag nothing had
ever pushed. A publish workflow that went 200 releases without running. Every one of these
reported green. The pipeline's actual weakness is not that it breaks: it is that it stops
doing things without saying so.

Three findings below are correctness bugs live in `main` today. The rest is structure.

---

## What is genuinely good: do not "simplify" these

Worth stating plainly, because several of these look like complexity to a reviewer who has
not read the reasoning:

1. **Three verify groups as three reusable-workflow calls, not a matrix.** The reason given
   in `verify.yml`, Actions reports a matrix's result as one aggregate, so `needs: verify`
   would be `failure` when any leg broke: is correct and is the whole justification for the
   design. A matrix here would silently re-couple the platform deploy to the marketing site.
2. **A bind-mounted `/ci-cache` instead of `actions/cache`.** Measured, twice, with numbers
   (6m19s archiving, ~1-in-4 slot hit rate). This is the right call and the measurement is
   the reason it will survive the next person who suggests "just use the cache action".
3. **The fork boundary as two controls that each cover the other's blind spot**, plus a
   prepass invariant that grows the safe set to a fixpoint rather than enumerating it. This
   is the single best-designed thing in the repository.
4. **Per-job `CARGO_TARGET_DIR`.** The lock-plus-fingerprint reasoning is exactly right and
   is a mistake almost everyone makes.
5. **Per-SHA concurrency group on `main` pushes.** The analysis of why a shared group with
   `cancel-in-progress: false` is worse than no grouping is correct and non-obvious.
6. **Provenance end to end**: assets, both images by digest, npm tokenless via OIDC, with
   the explicit refusal to fall back to an unattested publish. The reasoning that "an
   unattested release reporting success is a promise the pipeline does not keep" is the right
   call.
7. **Documenting the incident, not the mechanism.** `ci.yml` is 41% comment and almost all of
   it is *why*, tied to a specific failure. That is rare and valuable. See §4 for the cost.

---

## A. Correctness: live defects

### A1. `action-publish.yml` has a trigger that can never fire: the same bug, a third time

**Severity: high. FIXED (instance and class); the structural half is still open.**
`action-publish.yml` is now `on: workflow_dispatch` and named in `dispatch-publish.sh`'s
`WORKFLOWS`. `prepass.mjs` invariant 10 fails any workflow whose `on:` block declares
`push: tags`, verified both ways: it reports this file when the old trigger is restored, and
passes on the fixed tree. Tagging with a GitHub App token (below) remains the better fix and
would retire the invariant; the invariant's own comment says so, so it cannot become a trap.

`action-publish.yml` is triggered by:

```yaml
on:
  push:
    tags: ["v*"]
```

The repository already knows this cannot work. `dispatch-publish.sh` opens with:

> `npm-publish.yml` and `vscode-publish.yml` used to say `on: push: tags` and read as if the
> tag started them. It never did, not once in 200 releases: semantic-release pushes its tag
> with the built-in `GITHUB_TOKEN`, and GitHub deliberately starts no workflow from an event
> that token created.

`action-publish.yml`'s own header claims it uses "the same trigger and shape as
`npm-publish.yml`". It does not: `npm-publish.yml` is `workflow_dispatch`. And
`dispatch-publish.sh` dispatches exactly two workflows:

```bash
WORKFLOWS=(npm-publish.yml vscode-publish.yml)
```

So the gate action is built by a workflow that never runs. It fails exactly the way the
previous two did: green release, nothing published, no signal. `GATE_ACTION_TOKEN` being
absent would mask it further: the script skips loudly, but nothing is there to skip.

**Immediate fix:** add `action-publish.yml` to `WORKFLOWS` and change its trigger to
`workflow_dispatch`.

**Structural fix (recommended):** this class of bug recurs because *the tag is pushed by a
token that is deliberately inert*. Push the tag with a GitHub App installation token (or a
fine-grained PAT) instead of `GITHUB_TOKEN`, and `on: push: tags: ["v*"]` starts working for
all three publish workflows: as originally written. `dispatch-publish.sh`, its `actions:
write` permission, and the entire "which workflows are in the list" coupling all disappear.
That is one credential in exchange for deleting a whole mechanism and the failure mode it
carries.

**Guard either way:** a prepass invariant that fails any workflow file whose only trigger is
`push: tags`, this repository can never use that trigger correctly while it tags with
`GITHUB_TOKEN`. Ten lines, and it closes the class rather than the instance.

### A2. `dind-host:latest` moves before the sandbox manifest merge: the two can skew

**Severity: medium. FIXED.** The `images` job now pushes `dind-host` under the immutable SHA
tag only, and `images-merge` promotes it to `latest` with the new
`_tools/scripts/image/promote-image-tag.sh`: a one-source `imagetools create`, the single-arch
counterpart of `merge-image-manifests.sh`. Both images are behind the same `needs`, so they
move together or neither moves. `release-images.sh` and `rollback-stable.sh` still spell the
same promotion inline; folding them onto the script is a follow-up, deliberately not done as a
drive-by on the rollback lever.

In `ci.yml`'s `images` job:

```yaml
- run: TAGS="latest sha-${GITHUB_SHA::8}" ARCH_SUFFIX=-amd64 IMAGES=sandbox ...   # arch-suffixed
- run: TAGS="latest sha-${GITHUB_SHA::8}" IMAGES=dind-host ...                     # plain latest, now
```

`sandbox:latest` only moves later, in `images-merge`, and only if `images-arm64` also
succeeded. The comment on `images-merge` states the intent precisely: "until this runs,
`latest` still points at the previous merge, so a consumer mid-pipeline never sees a
half-published tag": but `dind-host:latest` is published unconditionally in the earlier job
and is not covered by that guarantee.

`images-arm64` runs on GitHub-hosted arm with cold caches and a 90-minute budget; it is the
most likely leg to fail. When it does, the registry is left with a **new** `dind-host:latest`
and the **previous** `sandbox:latest`. `nightly.yml`'s `e2e` and `desktop-setup` consume both
by `latest`, as does anyone following install instructions.

**Fix:** push `dind-host` under an arch/staging tag in `images`, and move its plain-tag
promotion into `images-merge` alongside the sandbox stitch. Both images then move together or
not at all.

### A3. The path filters encode a dependency claim nothing verifies

**Severity: medium, the failure mode is silent under-testing, which is the worst kind. APPLIED,
and it found a live defect on the way.**

`_tools/scripts/verify/affected.mjs` now answers the four product triggers by walking the workspace
dependency graph (every `package.json`'s `workspace:` edges, the same graph turbo reads) from
the changed files up through every package that transitively depends on one. The image payload
is read out of `prepare-image-trees.sh`'s own `TREES`/`BUNDLES`, so the list that file already
warns about ("both times an extension joined the payload the filter was the line that was
missed") has no fourth copy.

Not `turbo --affected`, which would be authoritative, for one reason: the `changes` job runs
before any install (it is ~23 seconds and it is a DAG root gating the whole pipeline) and
turbo lives in `node_modules`. Putting a 2m21s–3m43s install on that root to ask a question the
manifests already answer is the wrong trade. The walker was checked against `pnpm ls -r`: same
84 projects, no misses.

**The claim the old regexes rested on was false.** They asserted that `_editor`, `_platform` and
`_site` held no dependency of any image-bound package. `@intentic/ext-memory`,
`ext-knowledge` and `ext-deployments` (all three baked into the sandbox image) depend on
`@intentic/extension-ui`, which depends on `@intentic/ui` in `_editor/ui`. Every UI-kit change
had been skipping the image rebuild.

Verified by replaying both implementations over 150 commits of history: 62 identical, 88
differing. The differences fall into two families and both were checked against the real
manifests, `images: false → true` on UI-kit commits (the bug above), and `platform: true →
false` on vscode/connectors/tooling commits, where the old regex matched a whole group
directory and the graph shows no edge to `api` or `web`.

What stayed a regex is the small remainder a package graph cannot answer, listed together at the
bottom of the script so the distinction stays visible: the `ic` Rust crate, the shims bundled
into the installer, Dockerfiles and feature packs, the assembly scripts, and the workflow files.

Five hand-written regexes in the `changes` job decide what runs. Two of them rest on an
explicitly hand-verified, machine-unchecked claim:

```
# The three groups NOT listed (_editor, _platform, _site) hold no dependency of any
# image-bound package (checked against the four apps' workspace: deps); re-check that
# claim when moving a package between groups.
```

The file already records this drifting once: "hand-enumerating subdirs is how
iq/lsp/_extensions silently fell out of the trigger last time". A regex that stops matching
does not fail; it skips. Across 86 packages changing daily, "re-check that claim when moving
a package" is not a control.

The `desktop` filter is the sharpest example: a single ~380-character alternation that has
to stay in sync with the real closure of two smoke harnesses, a Windows driver, shared daemon
contracts, four build scripts and three workflow files.

**Fix: and this is the biggest single cleanup available.** Turbo 2.10.8 is already
installed, and it owns the real dependency graph. `turbo run <task> --affected` (with
`TURBO_SCM_BASE`/`TURBO_SCM_HEAD` set to the same two SHAs `changes` already computes) answers
"what actually changed, transitively" from the graph rather than from a regex. The `changes`
job becomes:

- compute base/head (keep the existing, good, zero-SHA fallback);
- run `turbo run build --affected --dry=json` once;
- derive each output from **package names present in the affected set**, not from paths.

That collapses five regexes into one query against the source of truth, deletes the "re-check
this claim" comment along with the claim, and makes a new package correct by default instead
of correct-if-someone-remembers. The genuinely path-shaped filters (`ci-base`, `ci-desktop`:
Dockerfiles turbo does not model) stay as they are, including the excellent `missing()` probe.

---

## B. Structure: the abstraction gap

### B1. Nine desktop jobs are one job shape written nine times

**Status: HALF APPLIED, the Windows tier is done, the desktop container shell is not.**

`windows-smoke.yml` is one reusable workflow with four inputs, called three times. It replaces
three copies of the same eleven steps whose comments pointed at each other ("for the reason
ci.yml's desktop-verify-windows spells out"), which is knowledge that only stays true while
somebody keeps three files in step. One behaviour was fixed on the way: the installer arguments
are now built as a PowerShell array rather than interpolated, because PowerShell drops an empty
native argument: `--expected-version $env:X` with no version would have handed the parser a
bare flag and let it swallow `--keep-installed`, which on the nightly would both fail the
version assertion and uninstall the app tiers 2 and 3 were about to use.

**The desktop container shell was deliberately not extracted**, and the reason is worth
recording rather than leaving as an omission. Ten jobs share a ~14-line preamble (container,
volumes, credentials, `CARGO_HOME`, checkout, pnpm-setup) but their bodies have nothing in
common. Collapsing them needs either a `run`-string input: an injection shape that would force
a suppression in the very lint added under B3: or moving eight job bodies into new shell files,
a large mechanical change with no way to exercise it here. The saving is ~80 lines against a new
indirection. It is the one item in this audit where the duplication is currently the better
trade; revisit it if those bodies become scripts for their own reasons.

The original argument:

`desktop-check`, `ic-check`, `desktop-verify`, `desktop-windows-build` (ci) · `windows-build`,
`linux-build` (release) · `desktop-setup`, `desktop-windows-build`, `update-survival`
(nightly).

Every one is: `runs-on: [self-hosted, intentic, desktop]`, `container: ci-desktop` with the
same volumes and the same inline `credentials`, `CARGO_HOME: /ci-cache/cargo`, a private
`CARGO_TARGET_DIR`, `checkout` with `clean: false`, `pnpm-setup`, then two to five `run`
lines. The shell is ~20 lines; the payload is ~4.

Across all 10 workflows: **25 container blocks, 39 inline `credentials` blocks, 35 checkout
steps, 14 `docker/login-action` steps.** A change to how a desktop job is built: a new mount,
a registry move, a credential rotation: is a 9-to-39-site edit that nothing checks for
completeness.

`nightly.yml`'s `desktop-windows-build` is a *verbatim* copy of `ci.yml`'s, differing only in
the artifact name. The Windows smoke preamble (checkout · download-artifact · pnpm ·
setup-node · filtered install · filtered build · teardown · doctor) exists in **three** places
with three sets of comments pointing at each other.

**Fix:** the repository already proved the pattern works: `verify.yml` is a reusable workflow
called three times with one input. Extend it:

- `desktop-job.yml`: reusable, inputs `(steps-script, cargo-target-dir, needs-docker)`. Nine
  call sites become nine 6-line blocks.
- `windows-smoke.yml`: reusable, inputs `(artifact-name, tiers, keep-installed)`. Three call
  sites, one definition, one place to fix a Windows-runner behaviour.
- A `ci-container` composite cannot help (`jobs.<id>.container` takes no composite), but the
  reusable-workflow boundary moves the whole block behind one file, which is the same win.

Realistic outcome: `ci.yml` drops from 974 lines to roughly 550, `nightly.yml` roughly halves,
and the three Windows preambles become one.

### B2. `clean: false` is shared mutable state, patched at each point of pain

**Status: APPLIED, for two of the three incidents.**

`.github/actions/prepare-workspace` is a `git clean -ffdx` with the kept set named: the thing
`clean: false` was always approximating, and which `verify.yml`'s own checkout comment describes
as the intent ("the Actions equivalent of `GIT_CLEAN_FLAGS: -ffdx -e node_modules`"). The
allowlist is `node_modules`, `.turbo`, `.cache`, `.image-out`, `dist`, `generated`, `.astro`,
`*.tsbuildinfo`. `dist-bin` is deliberately outside it, which is the whole point: that is where
the desktop bundles and machine agents stage, and a stale one was incidents 2 and 3.

Verified against a scratch repository with all eight kept patterns and both incident shapes
present: every cache survived, `pkg/dist-bin/BUNDLE.deb` and `windows-artifacts/setup.exe` were
removed. It runs in the eight jobs that stage or download artifacts, and it replaced the
bespoke "Clear the staging directories" step and both `rm -rf windows-artifacts` lines.

**It does not cover incident 1**, and that is stated in the action rather than implied: the
frozen injected copies are stale content *inside* `node_modules`, which the allowlist keeps.
Only the `pnpm-setup` composite's state-file removal reaches that. Two of the three, one rule.

The original argument:

Keeping the workspace between jobs is the right call: it is worth minutes per job and the
measurement in `ci-runner.md` supports it. But it makes the workspace a mutable object shared
by six runner processes across every workflow, and the repository has now hit that three
separate times, each fixed locally:

1. `node_modules/.pnpm-workspace-state-v1.json` freezing injected workspace copies: fixed by
   an `rm -f` inside `pnpm-setup`. The comment describes a deadlock where "no re-run could
   have gone green".
2. Stale `dist-bin` directories from a previous `0.0.0` desktop job being picked up by
   `release`'s assemble step: fixed by a bespoke "Clear the staging directories" step, after
   run 31697229807 failed on `2 'deb' artifacts … expected one`.
3. `windows-artifacts/` surviving a failed build: fixed by an `rm -rf` inside the staging
   step.

Three incidents, three unrelated patches, no shared rule. The fourth is waiting somewhere in
the ~35 checkout sites.

**Fix:** make it one decision instead of N. A single `prepare-workspace` composite action that
runs before every checkout and owns the invariant explicitly: "these paths survive between
jobs (`node_modules`, `.turbo`, `.image-out`); everything else is removed": implemented as an
allowlist, not an accumulating denylist. It replaces all three patches, and a new build output
is safe by default instead of dangerous by default.

### B3. `prepass.mjs` is a home-grown workflow linter where two standard ones exist

**Status: APPLIED.** `_tools/scripts/verify/lint-workflows.sh` runs both tools from `preflight`, at
pinned versions checked against a sha256 before unpacking, cached in `/ci-cache` (~1s warm,
~65ms of actual linting). `.github/actionlint.yaml` declares the three self-hosted labels:
without it every fleet job reported "label is unknown", 40 identical non-findings, which is
how a linter gets ignored and then deleted. `.github/zizmor.yml` holds this repository's three
deliberate exceptions, each with its reason and what would retire it.
Both were verified to fail on real defects (an injected dangling `needs`, an injected
`${{ }}` expansion into a `run:` block), not merely to pass on the current tree.

Three genuine High-confidence template-injection findings were fixed rather than suppressed:
`verify.yml`'s two `${{ inputs.filters }}` expansions and `ci.yml`'s `${{ github.ref }}` inside
the `missing()` probe, all now passed through `env:`. The equivalent two in `registry`'s
`scan.yml` are fixed the same way.

**The `artipacked` backlog is real and deliberately untouched.** 34 checkouts do not set
`persist-credentials: false`, which on a persistent workspace shared by six runner processes
means one job's token sits in `.git/config` while the next job runs. Fixing it needs per-job
judgement about which checkouts the release actually pushes from: `semantic-release` in the
`publish` job is the one that matters: and getting that wrong breaks releases in a way no
local check would catch. It is left out of the gate (`--min-confidence high` excludes it) and
recorded here rather than silently suppressed.

`shellcheck` is the other easy win not taken: `actionlint` shells out to it for `run:` blocks
and it is absent from `ci-base`, so those checks are currently skipped. Adding it would surface
findings across ~4,700 lines of bash: worth doing, not worth bundling into this change.

The original argument, for the record:

862 lines, nine invariants, including a YAML **line scanner** (invariants 4, 8, 9) written
because it must run before `pnpm install` and so cannot import a parser. The invariants
themselves are excellent (the fork-boundary fixpoint especially) and the "make both gates
runnable where the code is written" thesis is correct.

But three of the nine are re-implementations of things `actionlint` and `zizmor` do off the
shelf, with real parsers, maintained by people whose job it is: permission ceilings, runner
constraints, `${{ }}` interpolation into `run:` blocks, shell quoting, unreachable triggers,
and the untrusted-checkout patterns that turn a CI run into a credential leak. `actionlint`
is a single static binary with no install step worth speaking of; it belongs in `preflight`
next to `--checks-only`, and in the pre-push hook.

CodeQL's `actions` language covers part of this already: but it runs on GitHub-hosted
runners after the push, not as a gate, so it reports rather than prevents.

**Fix:** add `actionlint` + `zizmor` to `preflight`. Keep the repo-specific invariants (1-3, 5-7)
in `prepass.mjs`: nothing off the shelf knows about them. Retire the hand-rolled YAML line
scanner for 4, 8, 9 once the standard tools cover the same ground; that is the most
maintenance-heavy code in the whole CI layer and it exists to check things two tools already
check.

### B4. Two repositories, two supply-chain postures

**Status: APPLIED.** `registry`'s `scan.yml` now digest-pins both actions, pins `runs-on` to
`ubuntu-24.04`, and pins `@intentic/registry-scan` to `1.176.3`. That last pin is a no-op
today and worth noticing why: `1.176.3` is exactly what npm's `latest` resolves to, because it
is where the npm publish stalled during the tag-trigger bug. The nightly scan has been running
a scanner ~30 versions behind the tags: a second consequence of A1's siblings, visible only
once the version was written down.

`intentic/intentic` digest-pins every action with a version comment, sets narrow permissions
per job, and attests everything it ships. `registry`'s `scan.yml`: in the same organisation:
uses floating tags (`actions/checkout@v7`, `actions/setup-node@v7`), grants `contents: write`
plus `pull-requests: write`, and executes `npx --yes @intentic/registry-scan`, resolving an
unpinned package from npm at runtime, in a job that writes to `main`.

That is not a small gap: it is a mutable third-party dependency with write access to a branch,
sitting next to a repository that goes to considerable lengths to make exactly that impossible.
Scorecard scores `intentic` and will never look at `registry`.

**Fix:** digest-pin `registry`'s actions and pin `@intentic/registry-scan` to an exact version
(or a digest via a lockfile). If the org's posture is meant to be uniform, a shared reusable
workflow or an org-level ruleset is how that gets enforced rather than remembered.

---

## C. Performance

### C1. The desktop tree is built twice per releasing push, and the second build gates nothing

**Status: APPLIED.** `release.yml` now publishes its planned version as a `workflow_call`
output, and `ci.yml`'s `desktop-verify` and `desktop-windows-build` gate on that output being
empty: so the `0.0.0` set runs on exactly the main pushes where it is the only desktop
coverage, and never beside the release building the same tree at the real version.
`desktop-verify-windows` follows automatically through its existing `needs`.

Chosen over hoisting the release planning into `ci.yml`, which would have been the tidier data
flow and would have broken a documented invariant: the `release` concurrency lock deliberately
spans plan-through-publish, so that two pipelines cannot plan the same next version while the
first candidate is on Windows. The cost of the version actually chosen is that on a
non-releasing push the desktop jobs now wait for `plan` (and transitively for `verify-core`)
before starting: later signal on a job that gates nothing, which is the cheap side of the
trade.

On a push to `main` that touches the desktop tree **and** produces a release, this happens:

| Job | Workflow | Version | Budget |
| --- | --- | --- | --- |
| `desktop-verify` | ci | `0.0.0` | 90m |
| `desktop-windows-build` | ci | `0.0.0` | 90m |
| `desktop-verify-windows` | ci | `0.0.0` | 45m |
| `linux-build` | release | `<version>` | 90m |
| `windows-build` | release | `<version>` | 90m |
| `windows-verify` | release | `<version>` | 45m |

Four release-profile Tauri builds, in four separate cargo target directories, plus
`verify-desktop-install.sh` twice and a full Windows install/uninstall cycle twice.

The `0.0.0` half **does not gate the release**: `release` needs only `[verify-core, ci-base,
ci-desktop]`. It gates nothing but the pipeline's own red/green.

The rationale is sound: on a *non-releasing* main push those jobs are the only desktop
coverage. But the cost is paid on every push, releasing or not.

**Fix:** make the coverage conditional rather than unconditional. `release`'s `plan` job
already computes whether a version is being cut; expose it and gate `desktop-verify` /
`desktop-windows-build` / `desktop-verify-windows` on *no release planned*. Releasing pushes
then build the desktop tree once, at the real version, and non-releasing pushes keep exactly
today's coverage. Pull requests are unaffected: `desktop-check`'s debug build is already the
fast gate there.

Rough saving: two Tauri release builds and one full Windows verify cycle per releasing
desktop push: on the order of two to four runner-hours, including time on the single
Windows machine.

### C2. The Windows box is one runner, and it sits in the release critical path

`desktop-verify-windows` (ci) and `windows-verify` (release) both require
`[self-hosted, windows-desktop]`. Per `ci-runner-windows.md` that is **one machine, one
runner**, which must be started from a logged-in interactive session: so it cannot be a
service, and it cannot be scaled by adding processes the way the Linux fleet was.

Consequences:

- The two jobs serialize, and the ci one is upstream of nothing. A releasing desktop push
  waits out an irrelevant 45-minute-budget job before the release's own Windows verify can
  start. C1's fix removes this.
- The release critical path is `preflight → verify-core → plan → windows-build →
  windows-verify → publish`: six serial stages, budgets summing to ~290 minutes, with a
  single-runner machine at stage five. `ci.yml` itself puts the real figure at "up to two
  hours".
- It is a hard single point of failure for **all** publishing. No Windows box, no release:
  not just no Windows artifact.
- With `concurrency: release` and `cancel-in-progress: false`, GitHub queues exactly one
  pending run per group; a third push during a release cancels the queued second. No version
  is lost (semantic-release accumulates commits), but release latency under load is unbounded
  and the drop is invisible.

**Fix:** a second Windows runner is the direct answer and removes both the serialization and
the SPOF. If the interactive-session requirement makes that expensive, the cheaper move is
C1: it takes the redundant Windows job off the path entirely.

### C3. Six runner processes on one host is a ceiling, not a fix

`ci-runner.md` records the measurement that motivated 1 → 6: peak 1 executing, peak 21
waiting, median wait 10m29s, host idle 54%. Correct diagnosis, correct fix.

But six processes on **one** box share one kernel, one disk, one Docker daemon and one
`/ci-cache`. And the headroom is already gone: `ci-runner.md` said the widest wave was **five**,
which was true when six instances were provisioned: re-deriving it with that document's own
script gives **six** (the three verify groups plus `migrations`, `ci-base` and `e2e-hermetic`).
`migrations` took the spare slot and nobody re-ran the calculation. The document now says six,
and says the next job added to wave 1 needs a seventh runner process.

The waves also overlap by design (`images` starts while two verify groups still run). Meanwhile
each of the six-plus jobs pays its own `pnpm install --frozen-lockfile`, measured at
2m21s-3m43s and called "the largest uniform cost in the pipeline".

Two structural observations:

1. **The host is a single point of failure for everything**, including releases and including
   the credentials the fork boundary exists to protect. The runner doc names Actions Runner
   Controller and dismisses it as "more moving parts than six `svc.sh` installs": fair today.
   Worth revisiting on the specific trigger of *hardware failure being unacceptable*, not on
   elegance.
2. **Ephemeral runners would delete the fork boundary problem rather than defend it.** The
   whole two-control design in §A of `ci-runner.md` exists because the runners are persistent,
   share `/ci-cache` with `release`, and mount the host Docker socket. That is the correct
   response to the constraint: but the constraint is a choice. This is the one place where
   "more moving parts" buys a category of risk removed rather than mitigated.

Neither is urgent. Both are the right thing to reconsider the next time a runner incident
costs a day.

### C4. Small, cheap wins

- **The prepass runs three times.** `verify.yml` runs `node _tools/scripts/prepass.mjs`
  (~45 packages of `tsgo -b`, ~40s) in each of the three groups, and the file acknowledges it
  as "the standing cost of the split". It is a pure function of the checkout. Either make it a
  turbo task so `/ci-cache` deduplicates it, or emit it once and pass it forward as an
  artifact.
- **`images-arm64` and `sandbox-arm64` are the same build, twice.** Both prepare the arm64
  trees payload and push a sandbox tag; they differ only in the version stamped. On a
  releasing push both run, cold, on GitHub-hosted arm with a 90-minute budget each. Free in
  money, but they widen the release's wall clock. The release's `sandbox-arm64` could reuse
  the `sha-` tagged half `images-arm64` just published, retagged: the comment explains the
  skew concern honestly, but retagging a digest is not a skew.
- **`--filter=!@intentic-app/web` in `verify-core`** is measured at ~13 of that job's 20
  minutes. Good fix. Worth noting it is exactly the kind of surgical exception that
  `--affected` (§A3) would make unnecessary.

---

## D. Documentation

`ci.yml` is 41% comment. The prose is excellent and almost all of it is causal: every
decision names the incident that produced it. That is the right instinct and it should not be
lost.

It is also, at 406 lines of prose in an executable file, a design document that happens to
run. Two costs, one of which has already been paid:

1. **The prose can drift from the code and nothing notices.** `action-publish.yml`'s header
   asserts it uses "the same trigger and shape as `npm-publish.yml`". It does not, and the
   discrepancy is the live bug in §A1. Comments are unexecutable claims; this one was false
   from the day it was written.
2. **`docs/ci-runner.md` already exists and is the right home** for the durable reasoning:
   the fork boundary, the cache measurements, the label design, the ownership hazard. Several
   of those arguments now live in both places in slightly different words.

**Suggestion, not a rule:** keep in the YAML the comments a reader needs *at that line* to
avoid breaking it, `shell: bash` because the default is `sh`, `!cancelled()` not `always()`,
`${{ }}` wrapping a leading `!`. Move the long-form arguments: why three verify groups, why
a bind mount, why the fork boundary needs two controls: to `ci-runner.md` and link them.
`ci.yml` gets appreciably shorter without losing anything, and the arguments live where they
can be read as a whole rather than as 40 asides.

**Status: partial.** Two stale factual claims in `ci-runner.md` are corrected, the widest wave
(five → six, §C3) and the `runs-on` job table, which had drifted to missing eleven jobs. Both
now carry the command that regenerates them, because both went stale the same way: a number
written once as a sentence. The larger prose migration out of `ci.yml` is untouched; that is a
judgement call about the file's character, not a defect, and it should be the author's.

---

## Recommended order of work

Ranked by (correctness × cost-to-fix), highest first.

| # | Change | Why | Effort | Status |
| --- | --- | --- | --- | --- |
| 1 | Dispatch `action-publish.yml`; add the "no `push: tags`" invariant | §A1, live, silent, third recurrence | ~1h | **done** |
| 2 | Promote `dind-host:latest` in `images-merge` | §A2: live tag skew on any arm64 failure | ~1h | **done** |
| 3 | Gate the `0.0.0` desktop jobs on "no release planned" | §C1/§C2: 2-4 runner-hours per releasing push, clears the Windows path | ~half a day | **done** |
| 4 | `actionlint` + `zizmor` in `preflight` | §B3: closes the silent-no-op class with off-the-shelf tools | ~2h | **done** |
| 5 | Replace the path-filter regexes with a dependency-graph walk | §A3: deletes an unverifiable claim (which was false), kills five regexes | ~1-2 days | **done** |
| 6 | `windows-smoke.yml` reusable workflow | §B1: 3 duplicates → 1. The desktop-container half is deliberately not done; §B1 says why | ~1-2 days | **half** |
| 7 | `prepare-workspace` composite with an explicit survival allowlist | §B2: replaces two of three ad-hoc patches with one rule | ~half a day | **done** |
| 8 | Pin `registry`'s actions and its scan package | §B4: write access to `main` via a floating dependency | ~1h | **done** |
| 9 | Tag with a GitHub App token; retire `dispatch-publish.sh` | §A1 structural: removes the mechanism, not the instance | ~half a day | open |
| 10 | Move long-form reasoning from `ci.yml` into `ci-runner.md` | §D: prose already drifted once, into bug #1 | ongoing | partial |

Item 9 is what remains and it is small, but it needs a credential only a maintainer can create:
a GitHub App installation token (or a PAT) for the tag push. Doing it retires `dispatch-publish.sh`,
its `actions: write` grant, and prepass invariant 10 in one go.

The `artipacked` backlog under B3 is closed: 31 of the 33 checkouts now set
`persist-credentials: false`, the two that run semantic-release keep it and say why, and
`zizmor` runs with **no confidence floor** so a checkout added without the flag fails the lint
rather than eroding the cleanup one job at a time.

**What the applied changes have not been through:** a real pipeline. What *was* checked here:
`actionlint` and `zizmor` clean on both repositories at full sensitivity and confirmed to fail
on injected defects (a dangling `needs`, a `${{ }}` in a `run:` block, a checkout without
`persist-credentials`); all prepass invariants passing, with invariant 10 confirmed to catch the
restored trigger bug; `affected.mjs` replayed against 150 commits and its two disagreement
families traced back to the real manifests; its package walker compared against `pnpm ls -r`
(84 projects, no misses); the workspace allowlist exercised against a scratch repo holding both
incident shapes; the promote script dry-run against a stub `docker`; every shell script
syntax-checked; `pnpm verify` green; and the DAG re-derived (widest wave 6 before and after,
wave 3 down from 6 jobs to 4).

What cannot be checked from here is the first run itself. Watch these on the first main
pipeline: the `preflight` job's new network fetch of the two linters; `release.yml`'s `version`
output reaching `ci.yml`'s `needs` context; `prepare-workspace` on a workspace that has been
accumulating for weeks; and the three `windows-smoke.yml` callers against the one Windows
machine.

---

## One closing observation

The recurring failure in this pipeline is not fragility, it is **silence**. Six documented
incidents: the unfireable tag triggers (twice), the never-published `ci-desktop` image, the
regex that dropped three packages, the frozen injected copies, the private sandbox image:
all share one shape: something stopped happening, and the pipeline reported success.

The repository's response each time has been to add a guard where the silence occurred, and
those guards are good. But the general fix is not more guards. It is to **delete the places
where "nothing happened" and "everything passed" look identical**: which is exactly what
items 1, 4 and 5 do: a trigger that cannot silently fail, a linter that reads the triggers, a
dependency graph that cannot silently stop matching. Those three, together, close the class
rather than the next instance of it.
