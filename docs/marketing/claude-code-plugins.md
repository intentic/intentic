# Claude Code plugins — the context-hygiene wedge

The marketplace wedge that needs no sandbox, no Docker, no account: plugins that make a stock Claude Code
session cheaper and sharper, installed by name, working on the very next session. Two plugins, one repo
marketplace, one promise. This is the scope for getting both submittable; the companion analysis of *why*
this wedge over the sandbox-shaped ones is in the conversation that produced this doc, and the mechanics it
ports are documented in [`_sandbox/sandbox/docs/output-cleaners.md`](../../_sandbox/sandbox/docs/output-cleaners.md).

## What already exists (more than expected)

- **The `iq` plugin is built.** [`_search/iq/plugin/`](../../_search/iq/plugin) — manifest, the iq skill, a
  SessionStart nudge + background transcript ingest, a UserPromptSubmit session-recall matcher. The repo root
  is already a Claude Code **marketplace** ([`.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json))
  listing it, and the iq README documents `/plugin marketplace add intentic/intentic`. The binary is on npm
  (`@intentic/iq`, currently 1.176.x).
- **The output cleaner is plugin-shaped by accident.** The whole pipeline is dependency-free `.mjs` on node
  builtins only: [`cleaners.mjs`](../../_sandbox/sandbox/bin/cleaners.mjs) (692 lines, the registry),
  [`agent-output-filter.mjs`](../../_sandbox/sandbox/bin/agent-output-filter.mjs) (189 lines, exports
  `filterOutput`), [`retrieve-output.mjs`](../../_sandbox/sandbox/bin/retrieve-output.mjs) (44 lines), each
  with tests beside it. Only the *plumbing* is sandbox-specific (`tmux-run` tees pane logs; the daemon's
  PreToolUse rewrite threads env). Claude Code's hook API now supports exactly the missing piece:
  a PostToolUse hook may **replace a tool's output** (`updatedToolOutput`) before the model sees it.

## Plugin 1 — `iq` (finish, don't build)

Remaining work is release hygiene, not code:

1. Version the manifest (it says `0.0.0`) and adopt a bump rule — marketplace users only update on a bump.
2. `claude plugin validate _search/iq/plugin` clean (the community review pipeline runs the same check).
3. Submit via the Console form (`platform.claude.com/plugins/submit`) → `anthropics/claude-plugins-community`;
   approved plugins are pinned to a commit SHA and CI re-pins on push.
4. README: the install is two steps (binary from npm + plugin from marketplace) — keep leading with that,
   since the plugin deliberately ships the *teaching*, not the binary.

Estimate: an afternoon, mostly the submission round-trip.

## Plugin 2 — `trim` (the port)

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
`tool_response`), write the **raw** output to a per-session log (rotating dir under the user's Claude home —
this replaces the tmux pane log as the lossless half), run `filterOutput`, emit
`{ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput } }`. Fail-open exactly like the
original: any error → emit nothing, Claude Code keeps the raw output. The footer already prints
`retrieve-output <log> [pattern]`, and `bin/` puts that command on PATH, so retrieval works verbatim.

**Port deltas, all small:**

- Exit-code asymmetry: the filter keeps everything on failure. **Verify what `tool_response` actually
  carries for Bash** (first task: a debug hook that dumps one real payload). If no usable exit signal,
  fail toward the failure shape (generous tail, no command cleaners) — never toward trimming an error.
- Config: keep the `INTENTIC_OUTPUT_CLEANERS` spec (env), default all-on. No UI; the settings-page story
  stays sandbox-only.
- The ledger (`filter-stats.jsonl`) keeps writing next to the logs — it costs nothing and makes
  `trim-savings` (and future marketing numbers: "−12% measured on 11k real commands") honest.
- Interplay with Claude Code's own output truncation: check whether the hook sees pre- or post-truncation
  text; the cap budgets may need to sit under the harness's ceiling rather than the sandbox's.
- The terse steer (`terseOutput`) ships **off by default** behind an env toggle, documented as
  experimental — its own A/B in the sandbox has not yet excluded zero, and the plugin should not sell an
  unproven number.

**Placement — the one structural decision.** A marketplace install takes the plugin directory alone, so the
plugin must be self-contained: the three scripts **move into the plugin dir**, which becomes their single
source. The sandbox consumes them from there (image copy paths in the Dockerfile, `tmux-run`'s default
filter command, test imports — all mechanical). No copies, no build step; the sandbox and an external user
run byte-identical cleaners, same as the iq plugin already does for the skill. Proposed home:
`_sandbox/sandbox/plugin/` (the sandbox package stays the owner and the benchmark harness stays where the
corpus is), listed in the root `marketplace.json` beside iq.

**Explicitly out of v1:**

- Any per-cleaner UI, the savings charts, holdout experiments — sandbox-only instrumentation.

**Estimate:** adapter + log rotation + payload verification ≈ a day (tests included, reusing the existing
filter tests as the spec); the file moves + image/reference updates ≈ half a day; manifest, validate,
marketplace entry, README ≈ half a day. Submission after a week of dogfooding on real local sessions —
the cleaner's own history says the corpus, not the fixtures, is where the surprises live.

## Sequence

1. iq plugin: version + validate + submit (unblocks the discoverability story immediately).
2. `trim` v1: adapter build, moves, dogfood, submit.
3. Phase 2 (separate decision): `trim-savings` polish, cross-promo between the two plugin READMEs.
