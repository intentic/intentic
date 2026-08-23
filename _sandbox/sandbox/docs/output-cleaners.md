# Output cleaners

Token-reduction for the agent's shell output, plus a couple of adjacent knobs. Everything here is toggle-able and
A/B-benchmarkable: flip a config, measure the delta.

## How it works

Every agent Bash command is rewritten by a PreToolUse hook (`src/agent/agent-terminals.ts`) to run through
`bin/tmux-run`, which tees the raw combined output and pipes it to `bin/agent-output-filter` (a stdin→stdout
filter). **The filter's stdout is the tool result the model sees**: the transformation is invisible to the agent.
Fail-open: any filter error emits the raw output unchanged.

The filter is exit-code-asymmetric: on **success** it runs the matching command cleaners + a head/tail cap; on
**failure** it keeps everything (only collapsing identical runs and capping at a generous tail) so errors survive
verbatim. When lines are dropped it prints a footer naming the retrieval command (below).

## The cleaner registry: `bin/cleaners.mjs`

Each cleaner has a stable `id`, and there are two kinds:

- **Command-scoped** (`pnpm`, `apt`, `test`): a command regex plus a line transform.
- **Shape** (`ls`, `files`): no `match` at all. They are offered on every success and decide from the OUTPUT:
  `ls` rewrites long-listing entries to `<octal> <name> <size>`, `files` folds a run of ≥10 bare paths into one
  line per directory under a shared root. This is not a stylistic choice: a command regex cannot see past
  `cd x && …`, and a replay of the session corpus says four out of five agent commands are written that way.
  Both fall back to the lines they were handed when they recognise nothing (a non-English `ls` locale, a run of
  loose words), so being always-on costs nothing when they are wrong.

Global stages are `dedup` (collapse ≥3 identical consecutive lines), `cap` (head/tail truncation), and `redact`
(mask secret-named assignments, AWS keys, bearer tokens, URL creds: on both success and failure).

Two things `cap` and `redact` each learned the hard way, because both were measured wrong for a while and both
cost the model real information:

- **A deliberate read is not a log.** `cat`, `sed -n`, `awk`, `git diff/show`, `git log -p` get the Read tool's
  2000-line ceiling and are trimmed from the END; everything else gets head 30 / tail 50. What `READ_COMMAND`
  matches against is the LAUNCHER line (`nsenter … bash -c '…'`), not the shell statement: so it is anchored on
  a non-word character rather than a statement start. Anchored the other way it recognised `cd x && cat y` and
  missed a bare `cat y`, which over one day misread 88 of 93 shell reads as logs and gutted the middle out of,
  among others, five reads of the workspace README. Git's global options sit *between* the two words, so the
  verb is matched past them (`git\s+(?:-\S+\s+)*diff`): `git --no-pager diff` is the spelling this workspace's
  own instructions ask for, and without that it read as a log and came back as 81 lines of a 274-line diffstat.
- **A LINE is not a unit of size.** The cap has a byte budget beside the line count: `LOG_MAX_BYTES` 16k,
  `READ_MAX_BYTES` 96k, because counting lines alone left a hole big enough to see in the ledger: **8.2% of one
  window's entire raw volume** arrived in commands *under* the 100-line limit, so the cap never looked at them.
  `grep -rn --include=*.css` over minified CSS returns sixty lines and 130 KB; a `curl` of a JSON API returns
  one. The budgets are set so ordinary output never meets them (the 80-line log cap is ~6 KB of normal text),
  which is what keeps this from becoming a second, stricter cap on everything.
- **A number is never a credential.** The value has to look like one too: a known issuer prefix (`sk-`, `ghp_`,
  `AKIA`, `eyJ`…) at any length, or letters-and-digits together, longer than a human types by hand, and not a
  path, a `${template}` or a SCREAMING_SNAKE variable name. A plain "≥6 characters with a digit" rule masked 182
  lines in a day and caught nothing: `"cacheReadTokens":26170149` (which also breaks the JSON for whatever reads
  it next), `inputTokens: 1234567`, `--max-tokens=131072`, and every short fixture value in the test suite. Its
  six-character floor made the mask fire on MAGNITUDE, `"outputTokens": 94746` survived and the same field one
  order up did not: so it passed every small test and only failed on real data.

**Add a cleaner:** append `{ id, match, apply }` (or a `strip(id, match, patterns)`) to `COMMAND_CLEANERS`:
omit `match` for a shape cleaner: and it joins `CLEANERS` automatically. Keep it dependency-free (the filter
must never break). Candidates surface from `discover` (below); today it names `grep`/`rg` grouping, by a wide
margin, as the next one worth writing.

**Deleting a cleaner is a normal outcome.** Eight command-scoped strippers (`npm`, `yarn`, `docker`, `git`,
`pip`, `lint`, `gh`, `build`) were removed after a corpus replay showed each removing *exactly zero* bytes over
10,682 real agent commands. A stripper that fires constantly and saves nothing is registry surface, a switch on
the settings page and a line in the ledger with no payer. `bench:cleaners corpus` is what settles the question.

## Toggle + benchmark

The active set is the **`outputCleaners`** per-sandbox setting (`.intentic/config/settings.json`), an iq-`--features`-style
spec:

- `""`: all cleaners on (default)
- `"off"`, no compression at all (raw baseline): the filter never runs (`INTENTIC_RUN_FILTER=0`). The only
  value that answers *whether* anything is cleaned; every other one selects *which* cleaners run
- `"git,pnpm"`: allow-list (only those)
- `"-cap"` / `"-dedup,-redact"`: default-minus (all except)

The daemon threads the spec to the filter as `INTENTIC_OUTPUT_CLEANERS` on the SDK env (`cleanerEnv`). The UI
exposes a master on/off in the Sandbox → Agent settings; finer specs are set via the `/settings` route for
benchmarking. Unknown tokens are ignored (fail-open).

**Provenance:** `agent-output-filter` appends one line per command to `historyRoot/logs/filter-stats.jsonl` with
`rawBytes`/`emittedBytes` + the active `cleaners` + which `matched` + `stageBytes`. This is the live A/B ledger.

`command` on that row (and the command the cleaners are matched against) is the line **as the agent wrote it**,
handed to the filter by `tmux-run -c`. By the time tmux-run runs it, the executed string carries the daemon's
wrapping (`nsenter --mount=/proc/<pid>/ns/mnt --wdns=… -- nice -n 10 ionice -c 2 -n 7 bash -c '…'`), which is ~100
characters of boilerplate before the agent's first word and a per-turn pid that makes every row unique. Recording
that instead is what made the un-cleaned-commands report unreadable and ungroupable.

**Per-mechanism attribution:** `stageBytes` maps stage id → bytes that stage removed, weighed against what
reached it (`cleanLines` returns `{ lines, stages }`). Sequential by construction, so the stages sum exactly to
raw − emitted and stack into one bar; the flip side is that a cleaner running before the cap is credited with
lines the cap would have taken anyway, so this is **not** "what turning it off would save": the holdout is the
only whole-pipeline counterfactual. Three stages have no toggle: `ansi` (escapes/`\r` frames), `footer`, which is
**negative** (the retrieval pointer adds bytes, and it rides the same ledger as what it bought) and `guard`.

**Never worse than raw.** The pointer is attached only when the trim it explains is bigger than the pointer
itself: dropping one `total 48` header bought ten bytes and used to buy a 122-byte footer with them, which is how
`ls` came to hand the model *more* than the raw listing. Behind that rule `guard` is total: if the final text is
longer than what came in, the raw capture goes out instead and the stages sum to zero, so no future cleaner can
make a result worse than not running. Over the session corpus this took results-made-bigger from 193 to 0.

**`guard` firing constantly is a bug report, not a safety net working.** It reverts the WHOLE pipeline for that
command, so a cleaner that keeps tripping it throws away every other cleaner's work alongside its own. Read the
two together on the ledger: `cache` once showed −17,980 tokens against `guard` +20,045, which is not two
mechanisms but one: 78 of 90 collapses reverted, and the pair netting ~+2k from the 12 that survived. A stage
whose number is mirrored by `guard` is a stage firing where it should not. (Its counterpart on the ledger is the
1-byte-per-command `footer: -1` from re-adding a trailing newline, an accounting artifact, not a footer: over
one window 8,136 of 8,687 "footer added bytes" rows were that, and reading them as pointers overstates the
pointer's cost by an order of magnitude.)

**`cache` has a floor** (`CACHE_MIN_BYTES`, 512) because a body has to be worth more than the pointer replacing
it, and small ones never are: the marker is ~130 bytes before it names anything, so collapsing a four-byte "OK"
produced a result 400 bytes *longer*. The floor is not only an accounting fix: short bodies **collide** across
commands with nothing to do with each other, and the cross-command back-reference then names one of them, which
is how a desktop-install verification came back as "identical to the output of `sleep 90; cat
/tmp/smoke-run1.log`". A pointer the reader cannot act on is worth less than the bytes it saved. The named
command is truncated (`CACHE_COMMAND_MAX`) so the back-reference cannot balloon the marker it lives in.

**Offline bench:** `pnpm --filter @intentic/sandbox bench:cleaners` replays a fixture corpus through named configs
(off / all / no-cap / …) and reports Δtokens per config: deterministic, no agent (mirrors iq-bench).

`bench:cleaners corpus [dir]` runs the same sweep over **real session transcripts** (`~/.claude/projects` by
default) and prints the stage ledger for them. Quote this one. The fixtures are a sanity check that a cleaner
still fires; left to drift they become the outputs someone hoped to compress, and the two numbers separate by a
factor of five (fixtures said −51% while the corpus said −11%). Measured on 11,089 real Bash results: **−12%**,
of which `cap` is ~11 points: the specific cleaners are worth about one point together.

**Discover gaps:** `pnpm --filter @intentic/sandbox bench:cleaners discover <filter-stats.jsonl>` reports realized
savings and high-volume commands that matched **no** cleaner: i.e. where to add the next handler.

## Reversible retrieval: `bin/retrieve-output`

Trimming is lossy display, lossless storage: the full output stays in the persistent pane log. The filter footer
prints a ready-to-run command (`… full: retrieve-output <log> [pattern]`) and `retrieve-output` greps that log
(case-insensitive, literal fallback), budget-capped to ~2000 tokens so retrieval never re-floods context.

**The two halves of the footer are priced separately, because they are worth different things.** The counts
(`--- [exit 0, 4s] 120 lines filtered to 81`) ride every trim: ~24 bytes, and they are what stops a trimmed
result being read as a complete one. The retrieval HANDLE is gated on `RETRIEVAL_MIN_DROPPED` (20 lines),
because it is ~100 of the footer's ~124 bytes and it used to ride every trim however small. Measured over one
two-day window: 551 handles cost 17k tokens, 15.7% of everything the cleaners saved on those same commands:
**86% of them explained a trim of under twenty lines**, and across 10,446 agent commands `retrieve-output` was
invoked **zero times**. Nobody goes back for three elided lines of pnpm progress. The gate recovers ~10.4k
tokens per window and spends at most ~1.8k of it back, because a counts-only footer is small enough to fit
under the never-worse rule on trims where the full one did not.

Note the corpus replay is the WRONG instrument for this one and says it is a wash: its inputs are transcript
tool-results, which already carry the footers the live filter wrote. Ledger and transcripts, not the corpus.

## Output-side reduction: `terseOutput`

Separate from tool-output cleaning: the **`terseOutput`** setting appends a short concise-response steer to the
**end** of the system prompt (a stable suffix, so it composes with `stableSystemPrompt` and doesn't bust the
prompt cache), cutting the model's own output tokens. (Headroom-style effort routing is deferred: it maps poorly
to intentic's per-turn tool loop; revisit if benchmarks show model output dominates.)

**Measuring it needs an experiment.** A cleaned command yields its own baseline in the same event; a turn cannot
be re-run to see what it would have said unsteered. So **`terseHoldout`** (fraction [0,1], default 0) is a
turn-level holdout: `turn-plan.ts` flips the coin, and the arm it picked is stamped on the spend ledger
(`UsageTurn.terse`: absent means the turn was never in the experiment, e.g. a custom system prompt, which drops
the steer with everything else). `usage/turn-experiments.ts` reads the two arms back: mean **prose characters**
per turn, `n` per arm, and a Welch margin.

**It is judged on prose, not on output tokens**, because those are different quantities: measured over a day of
real turns the model's output is 91.6% tool-call arguments (an Edit's two strings, a Write's file body) and 7.8%
prose. The steer moves prose. Scored on the total, a fifth off the narration moves the number by 1.6%: well
inside the margin: so the experiment could not see its own treatment, and what it reported instead was whichever
arm had drawn the longer tasks. `UsageTurn.proseChars` counts the turn's `delta` frames; characters rather than
tokens because the provider bills one total and never breaks it down, and for a two-arm comparison the constant
cancels.

**A number is withheld twice.** Below `MIN_ARM_TURNS` (30) per arm it reports the arms and no delta. Past that it
reports the delta only if the 95% margin EXCLUDES zero: the steer crossed its thirtieth control turn and
published +31.2% ± 35.1pp, an interval from −3.4% to +66.7%, which is no measurement at all rendered as an
alarming number pointing the wrong way. The margin still goes out on its own: "smaller than ±35 points" is the
true reading, and the one that says to keep collecting rather than to go and change something.

**Pre-turn retrieval (`iqContext`) shipped as a fourth mechanism and was removed after being measured.** The
daemon searched the workspace for the user's opening message and prepended the ranked answer, so the turn would
open with anchors instead of buying them with its first searches. Three weeks of its own A/B killed it twice
over: delivery was structurally broken, the retrieval fired at conversation start, exactly when the box is
busiest, and the *median* attempt outran its 3s deadline (67% of eligible turns got nothing, at the cost of the
wait): and the turns the note did reach searched no less. On its own headline metric the arms were
indistinguishable (+18% ± 41.8pp on searches per turn), and the one reading that resolved pointed the wrong way
(+76.9% ± 72.8pp on searches before the first file). Resolving the null would have needed hundreds more control
turns, months away at any sane holdout. The `searchCalls`/`openingSearches` ledger fields it introduced remain:
they are what the iq search teaching is judged on.

## What the report says: `/settings/savings`

`SavingsReport` is three families, deliberately never one ranking:

- `input` (the cleaners, from `filter-stats.jsonl`. Exact, windowed by UTC day. `gaps`) the un-cleaned
  commands worth a handler: is **grouped by command line**, `commands` runs summing to `tokens`.
- `output`, the terse A/B above. One reading, `metric: "proseChars"`. Absent entirely when the experiment isn't
  running.
- `search`: the iq search teaching A/B, randomized per conversation. Two readings, `"searchCalls"` then
  `"openingSearches"`. Same `TurnExperiment` shape, same Welch machinery, same absence rule.

`TurnExperiment.metrics` is a head-and-tail tuple, not a plain list: one coin flip, one arm assignment, and N
readings over them: so the first is always the headline and a screen never has to check whether there is one.

The web renders `input` as one stacked bar (mechanisms + what reached the assistant) on the Usage tab, where the
range window lives, and each experiment reading through one arms chart (`SavingsArmsChart.vue`, metric-aware).
Each mechanism's figure is repeated next to its own switch on the Agent tab. Note the ledger
lives under `logsRoot` and is therefore pruned by `pruneLogFiles` (5 MB → newest 1 MB, 30-day idle): it is a
window of recent commands, not a lifetime record like `usage.jsonl`.

## Why there is one filter and not a choice of backend

`bin/tmux-run` reads `INTENTIC_FILTER_CMD` (default `agent-output-filter`): any stdin→stdout filter can be
dropped in for head-to-head benchmarking. That is the whole extension point. An external cleaner that **runs**
the command instead of filtering its output (rtk, headroom, `jfrog/boost`) needs a different shape: rewriting the
line to `<tool> <cmd>` at the PreToolUse hook with `INTENTIC_RUN_FILTER=0`.

**rtk shipped as exactly that for a while, behind a `filterBackend` setting, and was removed after being
measured.** The finding is positional, not qualitative: rtk has to be `argv[0]`, the native filter reads stdout.
Over 10,687 Bash commands from 200 session transcripts, `cd` is the first word of 8,546 of them: 80% of
commands, 82% of the output bytes: and `rtk cd …` cannot exec at all, so those lines had to run bare. 18.1% of
commands were prefixable; only 10.1% (6.5% of bytes) also had an rtk verb as `argv[0]` and would truly be
filtered. (rtk's own `rtk discover` reports a far larger opportunity because it strips the `cd … &&` prefix when
deriving a base command and prices each filter at a fixed percentage rather than measuring it: on a real `grep`
from this repo, its top-ranked opportunity saved nothing.)

Where rtk *did* fire it compressed better than a generic cap, which is why the `ls` and `files` shape cleaners
above are modelled on `rtk ls` / `rtk find`. Porting the behaviours was the part worth keeping; the backend
switch was a second code path, a settings field, and a screen full of per-cleaner toggles that did nothing
whenever it was on.
