# What DeepSeek Harness does better, and what of it intentic should take

An audit of `/work/refs/deepseek-harness` (dsh, `0.1.0-rc.8`) against this repository, looking for
mechanisms worth copying. dsh is a plugin-based agent harness on vendored Cordis — it *implements* an
agent loop, LLM adapters and tools. intentic *wraps* other people's harnesses (Claude Code, Codex,
OpenCode, ACP, Pi) inside a per-user sandbox and puts a product around them. So most of dsh's
substance — the loop, compaction, token metering, LLM seams — has nowhere to land here.

What does transfer is its **engineering discipline**: the mechanisms it uses to keep a 3,000-file
plugin graph honest. Those are architecture-agnostic, and several of them fill holes intentic
demonstrably has.

Ranked by (value × fit) ÷ cost.

---

## 1. Package-owned runtime invariants, with an exhaustiveness gate

> **Status: landed.** A registry now lives in the daemon (`_sandbox/sandbox/src/invariants/`), with four
> subsystems audited — `platform`, `agent`, `agents`, `capabilities` — and an exhaustiveness gate
> (`pnpm check:invariants`) carrying the remaining 53 as an open backlog. What follows is the analysis that
> motivated it; the section end records what was built and what was deliberately left.

**What dsh does.** There is a registry service (`ctx.invariants`) and every workspace package
publishes a `./invariant` companion entry point that registers checks against *its own* runtime
relationships. Each contribution runs in its own child fiber, declares the services it needs, and is
handed a `fail(message)` that throws an error branded with the owning package name.

The interesting part is not the registry. It is the rules around what may be registered, and the gate
that enforces coverage:

- A companion installs a check **only when the package owns an observable event relationship or
  mutable-data relationship**. Asserting that a method exists, that a plugin is named what it is
  named, or that a pure function returns a fixed value is explicitly *forbidden* — that is a type,
  load or unit-test concern. This is what stops the whole thing from decaying into ceremonial
  assertions.
- A package with no plausible runtime relationship ships an **empty installer with a
  package-specific comment** beginning `No runtime invariant:` explaining why. Pure utilities,
  composition-only packages and persistence adapters are the common cases.
- `verify-package-invariants` walks every workspace package and rejects: generated markers,
  unexplained empty installers, non-empty installers that ignore the reporter, wrong registration
  names, and incomplete export/publication/dependency/tsconfig/bundle wiring.

Live examples: session enclosure and call/result trace pairing, agent status transitions, inbox FIFO
conservation, model-request reconstructability, stream grammar, durable retry position and bounds,
tool-pipeline stage ordering and frozen results, hook pairing, provider/child pairing, approval
asked/decided audit pairing, goal revision monotonicity.

**Where intentic stands.** The word "invariant" appears in this repo only in prose. The runtime
relationships that *are* invariants here are written as English paragraphs in `ARCHITECTURE.md` and
in file-header comments, and nothing executes them:

- exactly one daemon per container holds the container claim, and only that one converges HOME-level
  state (ssh dir, git credentials, `~/.claude` stores, `authorized_keys`, the sweeps, the scheduler,
  the announce);
- the leftover sweep enumerates its own process group, so another daemon's processes are *not in the
  set* rather than filtered out of it;
- every in-flight turn is in the turn journal and cleared when it settles, so whatever survives a
  boot is exactly what the process died under;
- a capability's secret fields are the complement of its `echo` fields, and an entry is validated
  *before* the vault is consulted — a field left out of `echo` must still parse with the marker in
  its place or the capability silently vanishes;
- a disabled extension stays listed but contributes no plugin dir, PATH entry, listener, card, env
  var or autostart process.

Every one of those is a statement about live data or an event stream. Every one is currently
guarded by a comment. `secret-fields.test.ts` and `agent-catalog.test.ts` show the instinct is
already here — it just has no home, no exhaustiveness rule, and no way to run in production.

**Adoption.** A small registry in the daemon plus a `verify-package-invariants`-style gate over
`_sandbox/*`, `_platform/*`, `_editor/*`, `_extensions/*`. Enable it in dev and in e2e; ship it
off-by-default (or warn-only) in production. The exhaustiveness gate matters more than the registry:
without it this becomes an abandoned folder within two months.

**Cost:** moderate. **Payoff:** the highest on this list. It converts intentic's best asset — an
unusually precise understanding of its own invariants, written down at length — into something that
fails loudly instead of something a future change quietly violates.

### What was built

The registry (`invariants/invariants.ts`) runs checks at three named moments — `boot`, `turn-settled`
and a five-minute `sweep` — driven from `main.ts`, detached and never awaited. A check calls `fail` to
report; the registry catches, attributes it to the owning subsystem, logs at error level and records it
in a bounded ring. **Nothing is ever thrown at the daemon**: a sandbox must not lose a turn because a
diagnostic disagreed with it. A check that throws on its own account, or fails to settle inside five
seconds, is recorded as `broken: true` — a broken check is not evidence about its subject, and reading
it as if it were is how a diagnostic starts lying. Passes are serialized so two moments landing in one
tick cannot read the same mutable state twice. Duplicate owners and duplicate check names throw at
registration, because nothing is running yet when that mistake is made.

Four companions, each observing a relationship the repository already documents in prose:

| Owner | What it observes | The silent failure it ends |
| --- | --- | --- |
| `platform` | The container claim file still names this process, for as long as this process holds the container role — and a guest never holds it | The 2026-07-31 incident from the survivor's side: a second daemon takes the claim, and the first goes on converging HOME, sweeping processes and announcing on an answer that stopped being true |
| `capabilities` | No capability holds a real credential in the workspace manifest | The repo's own stated invariant, enforced only by a boot step, on a file the agent may edit at any time — so between two boots a token sits one ordinary `Read` from a model's context |
| `agent` | Every turn live longer than the grace has a journal entry | The journal write is best-effort and its failure is swallowed by design; the bill arrives at the next container recreate as a run that did not come back |
| `agents` | Every live turn reads as running on the fleet board | The turn path and the fleet registry each keep their own `running` flag and nothing reconciles them — a card at rest while the turn behind it spends the owner's allowance |

The gate (`_tools/scripts/verify-invariants.mjs`, wired into `pnpm check`) refuses five things: a
subsystem directory with neither a companion nor a backlog entry; a companion with no checks and no
written reason; checks that never call `fail`; a companion nobody imports; and a backlog entry naming a
directory that no longer exists. It was verified to fail on the first two, not merely to pass.

Violations surface without a wire-contract change: the durable resource series already samples every
minute, and now carries the count.

### What was deliberately left

Two checks were designed, found to be unprovable against the current code, and written down as deferred
rather than shipped flaky — each in its own companion, naming the change that would enable it:

- **A journal entry for a turn that already settled** (the next boot re-runs it, billed to the owner,
  unwatched). The clear is queued and the settled notification fires without awaiting it, so a stale
  entry cannot be told from one clearing right now. Needs a settled-at stamp on the run.
- **The fleet card that spins forever** — the registry holding `running` with no live turn. The registry
  records no moment at which it marked a conversation running, so the same ambiguity applies. Needs that
  stamp on the registry's runtime state.

Both are changes to the turn path rather than to its diagnostics, which is why they are not in this
change. The 53 unaudited subsystems are a visible backlog, not a silence: each entry is a promise to come
back, and the gate refuses to let the list grow.

---

## 2. OS-level command confinement as a seam that fails closed

**What dsh does.** `ctx.sandbox` is a capability seam: consumers hand over *the exact argv they are
about to spawn*, and a same-world backend wraps it under a per-call policy and reports what it
actually enforced.

The local provider probes and caches one platform runner: Linux prefers a working `bwrap` then
Landlock; macOS uses Seatbelt; Windows uses an ACL restricted-token runner. Details that make it
real rather than decorative:

- **Fail closed.** An unsupported platform or unusable runner returns `SANDBOX_UNAVAILABLE`.
  Execution never silently falls through unconfined.
- **Enforcement completeness is reported, not claimed.** Landlock on an older kernel ABI and the
  Windows restricted token both report `partial` rather than overstating.
- **Runner failure is distinguishable from command failure.** Landlock requires exit 125 *and* a
  `landlock-run:` fatal line; bwrap and Seatbelt are signature-only because neither reserves a
  launcher-failure status, and that asymmetry is documented rather than papered over.
- **One policy home.** `ctx.sandboxPolicy` owns the deployment default mode and the workspace root,
  and *both* the sandboxed shell executor and the sandboxed filesystem provider read it — so bash and
  file writes cannot confine to different roots.
- The launcher itself is ~300 lines of C11 over the raw kernel UAPI, statically linked against musl,
  shipped as prebuilt per-platform npm packages with no install-time build fallback. It restricts
  *itself* then `exec`s, so the ruleset is inherited across `execve` and every descendant is confined
  while the caller stays free.

**Where intentic stands.** No confinement of any kind. There is no `landlock`, `bwrap`, `seatbelt`
or `seccomp` anywhere in the repo. The agent is root in the container, and the container *is* the
whole boundary.

That is a defensible position, and `ARCHITECTURE.md` states it honestly for the capability manifest
("daemon and agent are both root in one container, so the split closes the leak that does not
require going looking"). But one claim in the same document is weaker than it reads:

> History — git snapshots every 60 s + per agent turn, on a `/history` volume mounted *outside*
> `/work` so an agent `rm -rf` can't reach it.

`/history` is mounted in the same container as a root agent. "Outside `/work`" is a path fact, not an
access-control fact. The same applies to the push VAPID private key, which is deliberately stored
there *because* it "sits outside the agent's reach".

**Adoption.** There is a ready-made injection point: every Bash tool command is already rewritten
through the tmux-run shim baked into the image (`agent-terminals.ts`). Wrapping that argv in a
Landlock launcher is a change at one site, not per-harness. A `workspace-write` mode granting
read-write on `/work` and `/tmp` and read-only elsewhere would make the `/history` claim true by
kernel enforcement, and would cost the agent nothing it legitimately does.

Take the seam shape too — per-call policy, reported enforcement level, fail-closed on an unusable
runner — not just the binary. And note the correct scope: this confines *the agent's own shell*, not
the harness process, so Claude Code and Codex keep working unmodified.

**Cost:** moderate (the launcher is published on npm; the wiring is small). **Payoff:** turns two
documented safety properties from convention into enforcement.

---

## 3. Decision records with a lifecycle, a closed taxonomy, and gates

**What dsh does.** `.agents/notes/` holds ~1,600 Agent Notes. Both axes are encoded in the path:
`{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`.

- **Lifecycle** is a folder the note *moves between*: `proposed/` → `implemented/` → `archived/`, or
  `rejected/`.
- **Class** is a closed set — `feature`, `bug-fix`, `simplification`, `architecture`, `process`,
  `testing` — defined in a script, and the classification gate rejects any other folder.
  `refactor` is deliberately absent because `simplification` already covers it.
- **`implemented/` notes are kept factually current with the code, in the same change.** When a file
  moves or a default changes, the note is updated to match — facts only, never the decision.
- **Archived notes are frozen.** A hash manifest enforces it. Documentation gates skip them, and they
  are explicitly not authority for current behaviour.
- **Cross-references are relative markdown links**, never prose or numbers, so they are mechanically
  checkable and survive folder moves.
- **Every non-trivial PR must add or update one.** Only mechanical, local edits are exempt.
- There is deliberately **no generated index** — the tree *is* the index, and the note explaining why
  is itself a note.

Rules for when a note may be deleted are unusually careful: full supersession only, every unique
rationale/alternative/consequence/coverage-gap preserved first, every inbound link repaired, and
"git history is the only remaining copy" explicitly rejected.

**Where intentic stands.** `ARCHITECTURE.md` is **14,800 words** of dense, genuinely excellent prose
that carries the decisions, the rationale, the rejected alternatives *and* the current-state facts,
all in one file with no lifecycle. `docs/` holds a scatter of design and audit documents with no
convention about status. The workspace knowledge base holds two decision records.

The failure mode is already visible: `ARCHITECTURE.md` mixes "this is how it works" with "this is why
we chose it and what we gave up", so neither can be revised without re-reading the other, and a
superseded decision has nowhere to go but deletion.

**Adoption.** Split rationale out of `ARCHITECTURE.md` into a lifecycle tree; leave `ARCHITECTURE.md`
as current-state only. Adopt the closed class set and the path encoding, the relative-link rule, and
the "update the implemented note in the same change" rule. The freeze/hash machinery is optional
polish — take it later if the tree grows past a few hundred.

**Cost:** low mechanically, real editorially. **Payoff:** high, and it compounds — this is the
mechanism that lets the other items on this list stay documented without inflating the one file
everybody has to read.

---

## 4. Word budgets on governing documents, as a gate

**What dsh does.** `scripts/doc-budgets.manifest.json` maps each governing document to a word
ceiling — root instructions 1,950; architecture 2,400; testing 1,150; docs instructions 1,320 — and
`verify-doc-budgets` runs in `doc-sync`. Raising a ceiling is permitted but is a deliberate, reviewed
act: "raise a `verify-doc-budgets` ceiling when the required content genuinely needs more space."

**Where intentic stands.** `ARCHITECTURE.md` is 14,800 words. `AGENTS.md` is 1,300. `README.md` is
2,100. Nothing bounds any of them, and the architecture document grows with every feature because
there is nowhere else for a feature's rationale to go.

**Adoption.** Trivial: a manifest, a script, one more entry in `pnpm check`. Its real function is to
make item 3 *stick* — a budget with no lifecycle tree to overflow into just blocks commits, but a
budget plus a notes tree turns "this file is too long" into "this paragraph is a decision record".

**Cost:** an afternoon. **Payoff:** disproportionate. Do this one and item 3 together or neither.

---

## 5. README section contracts: "Model Experience" and "Known Limitations"

**What dsh does.** Two gated sections in every package README.

`## Model Experience` — with `#### What the model sees`, `#### Token effect` and
`#### KV Cache effect` — states the package's effect on the agent's context. A package whose
contract is genuinely model-agnostic omits the section, but only if it is on an audited exemption
list *inside the gate script*, with a written reason:

```
'packages/core/scope': 'The package is a model-agnostic registration and lifecycle primitive; …'
'packages/util/brand': 'The package is a type-only primitive erased at compile time.'
```

Indirect contributors say so explicitly, naming the consumer that renders them, and still declare
their KV-cache effect ("No direct invalidation; the named consumer owns any request-prefix changes").

`## Known Limitations and Deferred Work` is required verbatim as an h2 with at least one top-level
bullet, and the gate also catches *drifted* variants — "Non-goals", "What is not here", "Deferred" —
so the section cannot be renamed into invisibility. Exactly one package is exempted, with a reason.

**Why this is the smartest documentation idea in the repo.** In an agent product, "does this change
what the model sees?" and "does this bust the prompt-prefix cache?" are load-bearing questions that
normally live only in the head of whoever wrote the change. This makes both a *declared, gated
property of every package*, and makes an absent section provably audited rather than possibly
forgotten.

**Where intentic stands.** The documenting skill mandates a README per package in a plain-language
house style, with computed rather than written figures — good, and better than dsh in some respects.
But there is no section contract, and intentic has a *lot* of surfaces that inject into agent
context: skills written per capability instance, capability cards, the AGENTS.md index for
loader-less runtimes, extension agent plugin directories, hooks, `${id}`/`${tools}` skill
substitution, environment drafts, context files. Which of those cost tokens every turn, and which
invalidate a cached prefix, is currently nobody's declared property.

**Adoption.** Add both sections to the documenting skill and gate them. The exemption-list-with-a-
reason pattern is the part to copy exactly — an allowlist in the gate script, not a convention.

**Cost:** low. **Payoff:** high, and it is squarely on intentic's actual subject matter.

---

## 6. Per-file 100% coverage, framed as dead-code detection

**What dsh does.** The CI gate is `test:coverage`, not `test`: **per-file 100%** on
`packages/*/*/src`. The framing is the point:

> An uncovered line is often dead code the gate is correctly flagging for deletion, not a missing
> test to bolt on. Line coverage is necessary, never sufficient — it proves lines ran, not that the
> feature works as shipped.

Platform-specific exemptions are explicit and narrow (one file, when `pwsh` is absent; CI runners
ship it and enforce the full bar), and there is a separate `coverage-exempt` script so exemptions are
themselves reviewed.

**Where intentic stands.** 980 test files, 12 spec files, and **no coverage configuration anywhere** —
no thresholds, no reporting, no gate. `pnpm verify` is typecheck + test.

**Adoption.** Do not start at 100% repo-wide; that would be a month of work and would teach everyone
to add `/* c8 ignore */`. Start with the packages that are pure logic and already well tested — the
contract package, the manifest package, the catalog packages — and ratchet. Adopt the *framing* from
day one: the deliverable of a coverage gap is usually a deletion.

**Cost:** low to start, high to finish. **Payoff:** real, but this is the item to sequence last.

---

## 7. Generated architecture graphs with a completeness guard

**What dsh does.** `docs/capability-seams.md` opens with `Generated by scripts/gen-doc-graphs.ts — do
not edit by hand`. It contains a ~200-node Mermaid graph of every service, its owning package, its
implementations and its direct consumers, plus a table with one row per service key: role
(`seam` / `core` / `bundle`), owner, implementations, consumers, companions, and a one-sentence note
about the ownership split.

Services are **discovered from the code's own declarations**. Roles are classified in the generator,
and the generator carries a **completeness guard**: a service nobody classified fails the build. That
last bit is what stops it becoming a stale picture.

**Where intentic stands.** `docs/architecture/index.json` and `repo.json` are generated (the
dependency graph, and figures computed rather than written — genuinely good, and the docs skill
already mandates computed figures). But the *architectural* pictures — the extension contribution
points, the capability kind → handler → effects table, the seam between core substrates and
extractable features — are hand-written prose in `ARCHITECTURE.md`.

Those three are exactly the things intentic already models as data: the manifest contribution points
are one file per point, the capability registry is a total `Record<CapabilityKind, Handler>` that
fails to compile when a kind is unhandled, and the effects taxonomy is a `Record` for the same
reason. All three are generatable, and the completeness guard would be nearly free given the
compiler already enforces totality.

**Cost:** low. **Payoff:** moderate — mostly it stops the architecture document drifting from the
registry.

---

## 8. Effect-scoped environment fact registry

**What dsh does.** `ctx.shellEnv` is a registry of trusted `DSH_*` variables collected fresh into
every shell call. Contributors register with a **stable name**, **declared keys with descriptions**,
and a `resolve(execution)` — and:

- **duplicate ownership fails loudly**;
- **an undeclared runtime key fails loudly** (a contributor cannot return a variable it did not
  declare);
- `list()` enumerates declarations *without executing providers*, so the set is introspectable;
- registration is effect-scoped, so unloading the contributor removes its keys;
- built-ins reserve their own names.

A location hint is documented as a hint (`DSH_SESSION_JSONL` "may not exist before the first flush
… and is not an authorization credential").

**Where intentic stands.** Capability env templates are injected into the agent's environment each
turn, per connector. There is no ownership registry, so two capabilities declaring the same variable
resolve by whatever order the fold happens to run, and nothing enumerates "what is in the agent's
environment and who put it there".

**Adoption.** Small and self-contained. The declared-keys-with-descriptions part also gives the
capability UI something honest to render.

**Cost:** low. **Payoff:** moderate; kills a whole class of silent collision.

---

## 9. One background-job registry over every kind of running work

**What dsh does.** `ctx.jobs` is a single contract covering background shell commands, terminal
sends and subagent delegations, with one model-facing controller tool reading, listing and killing
all of them. Notable contract details:

- **Owner isolation is the security fence**, explicitly, because ids like `bash-1` are predictable.
- `read` **consumes a single cursor** for stream jobs and is **idempotent** for final-output jobs.
- `kill` invokes producer cancellation *before* changing status; a cancellation throw leaves the job
  running rather than lying about it.
- `wait` returns a terminal snapshot or the live snapshot at timeout; settlement is first-wins.
- Two distinct notifications: `onJobDone` (terminal records, carries delivery meaning) and
  `onJobsChanged` (visible-set movement, owner-granular, carries none) — because *removal* is a
  change no per-job record can express.
- Registrations are **owner-relative**, so a composition that loads no controller cannot start work
  on the strength of another composition's controls.

**Where intentic stands.** Running work is spread across detached turn runs with a seq-stamped frame
log, tmux-managed terminals, extension processes, automation fires, subagent delegations and panel
dev servers — each with its own lifecycle, its own listing and its own idea of "still running". The
turn journal is a partial unification for one of those six.

**Adoption.** Not a small change, and intentic's spread is more justified than dsh's (these really
are different substrates). But the *vocabulary* is worth stealing even without the registry: the
`onJobDone` / `onJobsChanged` split, first-wins settlement, and "cancellation throws leave the job
running" are three distinctions intentic's surfaces currently make inconsistently.

**Cost:** high. **Payoff:** moderate. Consider the vocabulary now and the registry only if a third
surface needs the same list.

---

## 10. Durable projection checkpoints with a cold-read ladder

**What dsh does.** Session state is folded by registered projection units; a durable cache stores one
checkpoint record per session; listings read straight from it with zero I/O, and a cold read walks a
ladder — cached rows → restore floor anchored one event below the lowest usable watermark →
persistence read from that floor → refold → fail-soft write-back.

The discipline around it is the valuable part: **a stored row is a fold shortcut, never an
authority** — possibly stale (the watermark says exactly how stale) but never wrong. A version
mismatch **discards, never migrates**. **The log leads, the cache follows** — buffered events flush
durably *before* the cache row lands, so a crash leaves the cache behind the log, never ahead.
Records are bound to a **log lifecycle identity**, not just an id, so a deleted-then-recreated
session discards the unrelated record instead of seeding phantom values. Writes are whole-record. A
listing's watermark lets a client under higher-seq-wins reject a stale list that would otherwise
overwrite a newer live frame.

**Where intentic stands.** Better than expected. Session listing already avoids full transcript
reads (`sessions.ts` — spoken text alone, held for the daemon's life, which is what let the old
ten-session cap go), and history search shares one rule with the fleet board's filter.

The remaining gap is durability: that cache is in-memory, and `ARCHITECTURE.md` says container
recreation is *routine* here — every update, every environment approval, every dev swap. So the
first listing after any of those pays a full rescan, and turn-resume already exists precisely because
those restarts are expected.

**Adoption.** Not the full ladder. Take the checkpoint idea for the two things that already survive
restarts on the history volume, and take four rules verbatim: stale-never-wrong with an explicit
watermark, version mismatch discards rather than migrates, the log lands before the cache, and cache
records carry the lifecycle identity they were folded from.

**Cost:** moderate. **Payoff:** moderate.

---

## Smaller rules worth lifting into `AGENTS.md`

These are one-liners in dsh's instructions that encode real lessons and cost nothing to adopt:

- **Explicit defaulting at package boundaries.** Defaulting is an explicit `resolve(request): Spec`
  step in the owning implementation, never a hidden `?? default` inside `run()`. Every consumer then
  sees the same fully-specified value, and the default is one reviewable line.
- **No hardcoded tunables in plugins.** Anything that varies by deployment is a validated config
  field; "a `DEFAULT_*` constant or a test hook is not configurability". Protocol constants, external
  specs and security invariants stay fixed. dsh applies this hard enough that the projection cache's
  two flush knobs are *required with no defaults*, because "flush cadence is a deployment choice with
  no universally correct value".
- **Model-visible ⟺ logged.** Anything that reaches a model request must be reconstructable from the
  session log; a new model-visible input requires a session event. This is a strong, checkable
  version of a property intentic cares about a great deal and currently states only in prose.
- **Required-on-read log events with an explicit opt-out.** A build that does not know an event's
  type *refuses the log*, unless the event carries `ignorable: true`. Only structural format changes
  bump the format version. Fail-loud by default, with a documented escape hatch, is the right default
  for a durable format — and intentic's contract package is already the compiled-together keystone
  that would make this cheap.
- **An empty `catch` names what it swallows** and why nothing else can reach it, and the `try` stays
  one statement.
- **Trust TypeScript at typed same-process boundaries.** Do not add runtime validation, fallbacks or
  hostile-input tests for values the static interface already requires. Validate at exactly seven
  named boundaries: parser/config, queued, model/tool JSON, durable/file, worker, process, wire.
  Naming the list is what makes the rule usable.
- **Prefer symmetry for parallel values**; unexplained asymmetry usually signals a missed extraction.
- **Prose standard.** Before writing "contract", "boundary" or "shape", ask whether a more exact term
  names the subject — write "response fields", "JSON validation", "ESM exports". Keep "contract" for
  obligations callers actually rely on; keep "boundary" for a literal process, wire, security,
  transaction or lifecycle boundary. Also: no metaphors, and comments state complete contracts rather
  than reasoning transcripts. intentic's own prose is vivid and often excellent, but it leans on
  exactly these three words.

---

## What dsh does that intentic should *not* copy

Being clear about this matters, because dsh's discipline is not free and some of it is a bad trade
here.

- **Bilingual everything.** Every README, doc and Agent Note has a `.zh.md` twin plus an `.i18n.yaml`
  sidecar, with pairing gates, a translation-prompt snapshot and merge tooling. That is a DeepSeek
  requirement, not a quality practice.
- **The full gate fleet.** dsh runs roughly sixty named gates. Several are load-bearing (invariants,
  doc budgets, the README sections, coverage); many exist only because everything is a Cordis plugin
  loaded from YAML — config-source ownership, cordis-config verification, catalog generation,
  runtime-closure checks. Copying the count rather than the choices would be cargo cult.
- **Agent Notes on every non-trivial PR.** The rule is right; the *volume* (1,600 notes) reflects a
  team that writes a note for every seam split. Start with architecture and process classes only.
- **Code Mode and workflows.** dsh has a code-execution seam where the model writes one program
  against host-provided async bindings instead of making N tool calls, plus a worker-thread workflow
  engine. Genuinely clever, and a real token saving — but intentic does not own its agents' loops, so
  it cannot offer this without reimplementing what Claude Code and Codex already do.
- **The pre-release "no compatibility shims" stance.** intentic already has this (`CLAUDE.md`: no
  legacy support, no migration logic) — noted only to say it is one of the few places the two repos
  already agree exactly.

---

## Suggested order

| # | Item | Cost | Payoff |
|---|---|---|---|
| 1 | Doc word budgets | an afternoon | disproportionate |
| 2 | Decision records with lifecycle + closed classes | low mechanically | high, compounds |
| 3 | README section contracts (model experience, limitations) | low | high, on-subject |
| 4 | Package-owned runtime invariants + exhaustiveness gate | moderate | highest |
| 5 | Landlock confinement at the tmux-run shim | moderate | two claims become true |
| 6 | Environment fact registry with declared ownership | low | moderate |
| 7 | Generated architecture graphs with completeness guard | low | moderate |
| 8 | Durable projection checkpoints (four rules, not the ladder) | moderate | moderate |
| 9 | Coverage gate, ratcheted from the pure-logic packages | low → high | real, sequence last |
| 10 | Job vocabulary now, registry only on a third consumer | high | moderate |

Items 1–3 are documentation discipline and should go together — each one is weaker alone. Item 4 is
the single highest-value engineering change. Item 5 is the only security change on the list.
