# Claude Code plugins: the context-hygiene wedge

The marketplace wedge that needs no sandbox, no Docker, no account: plugins that make a stock Claude Code
session cheaper and sharper, installed by name, working on the very next session. Two plugins, one repo
marketplace, one promise. This is the scope for getting both submittable; the companion analysis of *why*
this wedge over the sandbox-shaped ones is in the conversation that produced this doc, and the mechanics it
ports live in [`_sandbox/output-cleaners`](../../_sandbox/output-cleaners).

## Status, 2026-09-29

Built as one plugin rather than two. [`_sandbox/claude-plugin`](../../_sandbox/claude-plugin) is the `intentic`
plugin: the `trim` port below, plus the project map, field notes, fileq and a `/intentic:stats` report, each
behind a `/config` switch. Its README says what it does and how it measures.

- The cleaners moved out of `_sandbox/sandbox/bin/` into their own package,
  [`_sandbox/output-cleaners`](../../_sandbox/output-cleaners). The sandbox image copies the same files it copied
  before, and the plugin bundles them, so the placement question in the `trim` section is settled that way.
- The project map, the reader for field notes and the brief their writer gets, how a session draws its arm, what each
  turn is scored on, and the comparison between arms moved from the daemon into
  [`_sandbox/agent-context`](../../_sandbox/agent-context), which the daemon and the plugin both import.
- The open question about exit codes is answered: Claude Code runs `PostToolUse` only for a command that succeeded,
  and a failure reaches Claude unchanged. A real `claude` 2.1.284 run accepted the hook's `updatedToolOutput`.
- The marketplace entry named `intentic` pointed at `./_platform/claude-plugin`, which the pricing change removed.
  It now installs `@intentic/claude-plugin` from npm.
- `@intentic/webq`, `@intentic/fileq` and `@intentic/claude-plugin` were published at 1.317.0 by hand, each has
  `npm-publish.yml` as its trusted publisher, and they close `PUB` in `_tools/scripts/lib/packages.sh`, so every
  release publishes them. A real `claude` 2.1.284 installed `intentic@intentic` from the published package and ran
  its hooks.
- iq was removed on 2026-11-18, with its standalone plugin and the `intentic` plugin's iq teaching. A randomized
  test found it made no measurable difference to agents, and it cost memory, disk and latency.

Still to do: submit the plugin to the community list. The sections below are the plan as it was written before the
build.

## What already exists (more than expected)

- **The repo root is already a Claude Code marketplace** ([`.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json)).
  When this was written it listed a standalone `iq` plugin (the iq skill, a SessionStart nudge and background
  transcript ingest, a UserPromptSubmit session-recall matcher), removed with iq on 2026-11-18.
- **The output cleaner is plugin-shaped by accident.** The whole pipeline is dependency-free `.mjs` on node
  builtins only: [`cleaners.mjs`](../../_sandbox/output-cleaners/src/cleaners.mjs) (692 lines, the registry),
  [`agent-output-filter.mjs`](../../_sandbox/output-cleaners/src/agent-output-filter.mjs) (189 lines, exports
  `filterOutput`), [`retrieve-output.mjs`](../../_sandbox/output-cleaners/src/retrieve-output.mjs) (51 lines), each
  with tests beside it. Only the *plumbing* is sandbox-specific (`tmux-run` tees pane logs; the daemon's
  PreToolUse rewrite threads env). Claude Code's hook API now supports exactly the missing piece:
  a PostToolUse hook may **replace a tool's output** (`updatedToolOutput`) before the model sees it.

## Plugin 1: `iq` (dropped)

The plan here was release hygiene for the standalone `iq` plugin: version the manifest, validate it, submit it.
iq was removed on 2026-11-18, plugin included, so none of it applies.

What still holds for any plugin submitted: marketplace users only update on a version bump, `claude plugin
validate` must be clean (the community review pipeline runs the same check), and submission goes through the
Console form (`platform.claude.com/plugins/submit`) → `anthropics/claude-plugins-community`, where approved
plugins are pinned to a commit SHA and CI re-pins on push.

## Plugin 2: `trim` (the port)

One plugin: Bash output arrives pre-cleaned, the full log stays retrievable, savings are inspectable.
Working name `trim`; the skill namespace becomes `/trim:…`.

**Shape:**

```
plugin/
├── .claude-plugin/plugin.json
├── hooks/hooks.json          # PostToolUse (matcher: Bash) → hook-filter.mjs
├── bin/                      # on the Bash tool's PATH while enabled
│   ├── retrieve-output       # moved here, unchanged
│   └── trim-savings          # small reader over filter-stats.jsonl (v1.1, optional)
└── scripts/
    ├── hook-filter.mjs       # NEW — the only real build (~100 lines)
    ├── agent-output-filter.mjs   # moved, unchanged (filterOutput is already exported)
    └── cleaners.mjs              # moved, unchanged
```

**`hook-filter.mjs`, the adapter:** read the PostToolUse JSON on stdin (`tool_input.command`,
`tool_response`), write the **raw** output to a per-session log (rotating dir under the user's Claude home:
this replaces the tmux pane log as the lossless half), run `filterOutput`, emit
`{ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput } }`. Fail-open exactly like the
original: any error → emit nothing, Claude Code keeps the raw output. The footer already prints
`retrieve-output <log> [pattern]`, and `bin/` puts that command on PATH, so retrieval works verbatim.

**Port deltas, all small:**

- Exit-code asymmetry: the filter keeps everything on failure. **Verify what `tool_response` actually
  carries for Bash** (first task: a debug hook that dumps one real payload). If no usable exit signal,
  fail toward the failure shape (generous tail, no command cleaners): never toward trimming an error.
- Config: keep the `INTENTIC_OUTPUT_CLEANERS` spec (env), default all-on. No UI; the settings-page story
  stays sandbox-only.
- The ledger (`filter-stats.jsonl`) keeps writing next to the logs: it costs nothing and makes
  `trim-savings` (and future marketing numbers: "−12% measured on 11k real commands") honest.
- Interplay with Claude Code's own output truncation: check whether the hook sees pre- or post-truncation
  text; the cap budgets may need to sit under the harness's ceiling rather than the sandbox's.

**Placement: the one structural decision.** A marketplace install takes the plugin directory alone, so the
plugin must be self-contained: the three scripts **move into the plugin dir**, which becomes their single
source. The sandbox consumes them from there (image copy paths in the Dockerfile, `tmux-run`'s default
filter command, test imports: all mechanical). No copies, no build step; the sandbox and an external user
run byte-identical cleaners. Proposed home:
`_sandbox/sandbox/plugin/` (the sandbox package stays the owner and the benchmark harness stays where the
corpus is), listed in the root `marketplace.json`. It landed as its own package instead, `_sandbox/claude-plugin`.

**Explicitly out of v1:**

- Any per-cleaner UI, the savings charts, holdout experiments: sandbox-only instrumentation.

**Estimate:** adapter + log rotation + payload verification ≈ a day (tests included, reusing the existing
filter tests as the spec); the file moves + image/reference updates ≈ half a day; manifest, validate,
marketplace entry, README ≈ half a day. Submission after a week of dogfooding on real local sessions:
the cleaner's own history says the corpus, not the fixtures, is where the surprises live.

## Sequence

1. `trim` v1: adapter build, moves, dogfood, submit.
2. Phase 2 (separate decision): `trim-savings` polish.
