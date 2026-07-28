# Output cleaners

Token-reduction for the agent's shell output, plus a couple of adjacent knobs. Everything here is toggle-able and
A/B-benchmarkable — flip a config, measure the delta.

## How it works

Every agent Bash command is rewritten by a PreToolUse hook (`src/agent/agent-terminals.ts`) to run through
`bin/tmux-run`, which tees the raw combined output and pipes it to `bin/agent-output-filter` (a stdin→stdout
filter). **The filter's stdout is the tool result the model sees** — the transformation is invisible to the agent.
Fail-open: any filter error emits the raw output unchanged.

The filter is exit-code-asymmetric: on **success** it runs the matching command cleaners + a head/tail cap; on
**failure** it keeps everything (only collapsing identical runs and capping at a generous tail) so errors survive
verbatim. When lines are dropped it prints a footer naming the retrieval command (below).

## The cleaner registry — `bin/cleaners.mjs`

Each cleaner has a stable `id`. Command-scoped cleaners (`npm`, `pnpm`, `yarn`, `docker`, `git`, `apt`, `pip`,
`test`) match a command regex and transform the lines; global stages are `dedup` (collapse ≥3 identical
consecutive lines), `cap` (head/tail truncation), and `redact` (mask secret-named assignments, AWS keys, bearer
tokens, URL creds — on both success and failure).

**Add a cleaner:** append `{ id, match, apply }` (or a `strip(id, match, patterns)`) to `COMMAND_CLEANERS`, or a
global stage in `cleanLines`, and add its id to `CLEANERS`. Keep it dependency-free (the filter must never break).
Candidates for new handlers surface from `discover` (below). `lint`/`ls` grouping are natural next additions.

## Toggle + benchmark

The active set is the **`outputCleaners`** per-sandbox setting (`.intentic/settings.json`), an iq-`--features`-style
spec:

- `""` — all cleaners on (default)
- `"off"` — disable the filter entirely (raw baseline; sets `INTENTIC_RUN_FILTER=0`)
- `"git,pnpm"` — allow-list (only those)
- `"-cap"` / `"-dedup,-redact"` — default-minus (all except)

The daemon threads it to the filter as `INTENTIC_OUTPUT_CLEANERS` on the SDK env (`agent.ts` `cleanerEnv`). The UI
exposes a master on/off in the Sandbox → Agent settings; finer specs are set via the `/settings` route for
benchmarking. Unknown tokens are ignored (fail-open).

**Provenance:** `agent-output-filter` appends one line per command to `historyRoot/logs/filter-stats.jsonl` with
`rawBytes`/`emittedBytes` + the active `cleaners` + which `matched`. This is the live A/B ledger.

**Offline bench:** `pnpm --filter @intentic/sandbox bench:cleaners` replays a fixture corpus through named configs
(off / all / no-cap / …) and reports Δtokens per config — deterministic, no agent (mirrors iq-bench). Add
representative captures to `bench/cleaner-bench.mjs` as `discover` surfaces them.

**Discover gaps:** `pnpm --filter @intentic/sandbox bench:cleaners discover <filter-stats.jsonl>` reports realized
savings and high-volume commands that matched **no** cleaner — i.e. where to add the next handler.

## Reversible retrieval — `bin/retrieve-output`

Trimming is lossy display, lossless storage: the full output stays in the persistent pane log. The filter footer
prints a ready-to-run command — `… full: retrieve-output <log> [pattern]` — and `retrieve-output` greps that log
(case-insensitive, literal fallback), budget-capped to ~2000 tokens so retrieval never re-floods context.

## Output-side reduction — `terseOutput`

Separate from tool-output cleaning: the **`terseOutput`** setting appends a short concise-response steer to the
**end** of the system prompt (a stable suffix, so it composes with `stableSystemPrompt` and doesn't bust the
prompt cache), cutting the model's own output tokens. (Headroom-style effort routing is deferred — it maps poorly
to intentic's per-turn tool loop; revisit if benchmarks show model output dominates.)

## Swapping the filter backend (external cleaners)

`bin/tmux-run` reads `INTENTIC_FILTER_CMD` (default `agent-output-filter`) — any stdin→stdout filter can be dropped
in for head-to-head benchmarking. Because rtk / headroom **run** the command rather than filter its output, wiring
one as a backend means either (a) a thin adapter script on PATH that shells to it as a stdin filter and set
`INTENTIC_FILTER_CMD` to it, or (b) rewriting the command to `<tool> <cmd>` at the PreToolUse hook with
`INTENTIC_RUN_FILTER=0`. `jfrog/boost` is proprietary — reference only, not bundlable.

**rtk is the one shipped alternate** — path (b), selected by the **`filterBackend`** setting (`"native"` |
`"rtk"`). The binary is baked into the sandbox image (`_apps/sandbox/Dockerfile`, `RTK_VERSION`), not shipped as
an installable extension fragment: `filterBackend` is a plain setting with no capability behind it, so nothing
would prompt for the install + rebuild an extension-gated binary needs — flipping it would just make every Bash
command fail with `rtk: command not found`. A backend switch must be usable the moment it is switched.
