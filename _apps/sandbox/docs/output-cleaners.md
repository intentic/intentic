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

Each cleaner has a stable `id`, and there are two kinds:

- **Command-scoped** (`pnpm`, `apt`, `test`) — a command regex plus a line transform.
- **Shape** (`ls`, `files`) — no `match` at all. They are offered on every success and decide from the OUTPUT:
  `ls` rewrites long-listing entries to `<octal> <name> <size>`, `files` folds a run of ≥10 bare paths into one
  line per directory under a shared root. This is not a stylistic choice — a command regex cannot see past
  `cd x && …`, and a replay of the session corpus says four out of five agent commands are written that way.
  Both fall back to the lines they were handed when they recognise nothing (a non-English `ls` locale, a run of
  loose words), so being always-on costs nothing when they are wrong.

Global stages are `dedup` (collapse ≥3 identical consecutive lines), `cap` (head/tail truncation), and `redact`
(mask secret-named assignments, AWS keys, bearer tokens, URL creds — on both success and failure).

**Add a cleaner:** append `{ id, match, apply }` (or a `strip(id, match, patterns)`) to `COMMAND_CLEANERS` —
omit `match` for a shape cleaner — and it joins `CLEANERS` automatically. Keep it dependency-free (the filter
must never break). Candidates surface from `discover` (below); today it names `grep`/`rg` grouping, by a wide
margin, as the next one worth writing.

**Deleting a cleaner is a normal outcome.** Eight command-scoped strippers (`npm`, `yarn`, `docker`, `git`,
`pip`, `lint`, `gh`, `build`) were removed after a corpus replay showed each removing *exactly zero* bytes over
10,682 real agent commands. A stripper that fires constantly and saves nothing is registry surface, a switch on
the settings page and a line in the ledger with no payer. `bench:cleaners corpus` is what settles the question.

## Toggle + benchmark

The active set is the **`outputCleaners`** per-sandbox setting (`.intentic/settings.json`), an iq-`--features`-style
spec:

- `""` — all cleaners on (default)
- `"off"` — no compression at all (raw baseline). Beats `filterBackend`: the filter is off (`INTENTIC_RUN_FILTER=0`)
  and the hook skips the `rtk ` prefix too, so this one switch means the same thing on either backend
- `"git,pnpm"` — allow-list (only those)
- `"-cap"` / `"-dedup,-redact"` — default-minus (all except)

The daemon resolves the two settings into one active backend (`agent.ts` `outputFilter`: `native` | `rtk` | `none`)
and threads the spec to the filter as `INTENTIC_OUTPUT_CLEANERS` on the SDK env (`cleanerEnv`). The UI
exposes a master on/off in the Sandbox → Agent settings; finer specs are set via the `/settings` route for
benchmarking. Unknown tokens are ignored (fail-open).

**Provenance:** `agent-output-filter` appends one line per command to `historyRoot/logs/filter-stats.jsonl` with
`rawBytes`/`emittedBytes` + the active `cleaners` + which `matched` + `stageBytes`. This is the live A/B ledger.

**Per-mechanism attribution:** `stageBytes` maps stage id → bytes that stage removed, weighed against what
reached it (`cleanLines` returns `{ lines, stages }`). Sequential by construction, so the stages sum exactly to
raw − emitted and stack into one bar; the flip side is that a cleaner running before the cap is credited with
lines the cap would have taken anyway, so this is **not** "what turning it off would save" — the holdout is the
only whole-pipeline counterfactual. Three stages have no toggle: `ansi` (escapes/`\r` frames), `footer`, which is
**negative** — the retrieval pointer adds bytes, and it rides the same ledger as what it bought — and `guard`.

**Never worse than raw.** The pointer is attached only when the trim it explains is bigger than the pointer
itself: dropping one `total 48` header bought ten bytes and used to buy a 122-byte footer with them, which is how
`ls` came to hand the model *more* than the raw listing. Behind that rule `guard` is total — if the final text is
longer than what came in, the raw capture goes out instead and the stages sum to zero, so no future cleaner can
make a result worse than not running. Over the session corpus this took results-made-bigger from 193 to 0.

**Offline bench:** `pnpm --filter @intentic/sandbox bench:cleaners` replays a fixture corpus through named configs
(off / all / no-cap / …) and reports Δtokens per config — deterministic, no agent (mirrors iq-bench).

`bench:cleaners corpus [dir]` runs the same sweep over **real session transcripts** (`~/.claude/projects` by
default) and prints the stage ledger for them. Quote this one. The fixtures are a sanity check that a cleaner
still fires; left to drift they become the outputs someone hoped to compress, and the two numbers separate by a
factor of five (fixtures said −51% while the corpus said −11%). Measured on 11,089 real Bash results: **−12%**,
of which `cap` is ~11 points — the specific cleaners are worth about one point together.

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

**Measuring it needs an experiment.** A cleaned command yields its own baseline in the same event; a turn cannot
be re-run to see what it would have said unsteered. So **`terseHoldout`** (fraction [0,1], default 0) is a
turn-level holdout: `turn-plan.ts` flips the coin, and the arm it picked is stamped on the spend ledger
(`UsageTurn.terse` — absent means the turn was never in the experiment, e.g. a custom system prompt, which drops
the steer with everything else). `usage/terse-savings.ts` reads the two arms back: mean output tokens per turn,
`n` per arm, and a Welch margin. Below `MIN_ARM_TURNS` (30) per arm it reports the arms and **no delta** — per-turn
output is spread far too wide for a handful of turns to separate the steer from the work.

## What the report says — `/settings/savings`

`SavingsReport` is two families, deliberately never one ranking:

- `input` — the cleaners, from the ledger of whichever backend is compressing (`filterBackend`). Exact, windowed
  by UTC day. `windowed: false` under rtk, whose `gain` reports no timestamps, so the UI labels it all-time.
- `output` — the terse A/B above. Absent entirely when the experiment isn't running.

The web renders `input` as one stacked bar (mechanisms + what reached the assistant) on the Usage tab, where the
range window lives, and puts each mechanism's saving next to its own switch on the Agent tab. Note the ledger
lives under `logsRoot` and is therefore pruned by `pruneLogFiles` (5 MB → newest 1 MB, 30-day idle): it is a
window of recent commands, not a lifetime record like `usage.jsonl`.

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

The hook only prefixes commands rtk can exec: rtk filters known subcommands (git, pnpm, tsc, …) and execs
unknown binaries unfiltered, but a shell-only first word — a builtin (`cd`), keyword (`for`), `VAR=` assignment
or compound syntax — cannot be exec'd, so prefixing it would kill the whole line with exit 127. Those commands
run bare and emit raw output under this backend, which is also rtk's own behaviour for anything it can't handle.

**How much that costs, measured.** Over 10,687 Bash commands from 200 session transcripts, `cd` is the first word
of 8,546 of them — 80% of commands, 82% of the output bytes — so under rtk those are uncompressed. 18.1% of
commands are prefixable at all; only 10.1% (6.5% of bytes) also have an rtk verb as `argv[0]` and would actually
be filtered. rtk's own `rtk discover` reports a much larger opportunity because it strips the `cd …  &&` prefix
when deriving a base command and prices each filter at a fixed percentage rather than measuring it — on a real
`grep` from this repo, its top-ranked opportunity saved nothing at all.

Where rtk *does* fire it compresses better than a generic cap, which is why `ls` and `files` above are modelled
on `rtk ls` / `rtk find`. The difference that matters is positional, not qualitative: rtk must be `argv[0]`, the
native filter reads stdout. That is the argument for porting rtk's behaviours rather than switching backend.
