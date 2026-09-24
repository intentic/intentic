# Output cleaners

Token-reduction for the agent's shell output, plus a couple of adjacent knobs. Everything here is toggle-able and
A/B-benchmarkable: flip a config, measure the delta.

## How it works

Every agent Bash command is rewritten by a PreToolUse hook (`src/agent/tools/agent-terminals.ts`) to run through
`bin/tmux-run`, which tees the raw combined output and pipes it to `bin/agent-output-filter` (a stdin→stdout
filter). **The filter's stdout is the tool result the model sees**: the transformation is invisible to the agent.
Fail-open: any filter error emits the raw output unchanged.

The filter is exit-code-asymmetric: on **success** it runs the matching command cleaners + a head/tail cap; on
**failure** it keeps everything (only collapsing identical runs and capping at a generous tail) so errors survive
verbatim. When lines are dropped, or long runs are cut inside a line, it prints a footer naming the retrieval command
(below).

The hook also prepends an EXIT trap to the command (`PIPESTATUS_TRAP`) that writes the last pipeline's per-stage
statuses to the file tmux-run exports as `INTENTIC_PIPESTATUS_FILE`; tmux-run hands them to the filter as its fifth
argument. And it brackets the first character of every `pkill -f`/`pgrep -f` pattern (`vite` → `[v]ite`,
`src/agent/tools/self-kill-guard.ts`): the call's own shells carry its text, so an unbracketed pattern matched and
killed them, leaving no output and nothing after the pkill run. A pattern still found on the wrapped line (repeated
later in the command, say) is refused with the reason.

## The cleaner registry: `bin/cleaners.mjs`

Each cleaner has a stable `id`, and there are two kinds:

- **Command-scoped** (`pnpm`, `apt`, `test`): a command regex plus a line transform.
- **Shape** (`diff`, `ls`, `files`, `hits`): no `match` at all. They are offered on every success and decide from
  the OUTPUT: `diff` replaces a generated file's hunks with a count, `ls` rewrites long-listing entries to
  `<octal> <name> <size>`, `files` folds a run of ≥10 bare paths into one line per directory under a shared root,
  `hits` says a search result's path once and indents that file's later hits under it. This is not a stylistic
  choice: a command regex cannot see past `cd x && …`, and a replay of the session corpus says four out of five
  agent commands are written that way. All four fall back to the lines they were handed when they recognise
  nothing (a non-English `ls` locale, a run of loose words, a timestamp that reads like `path:line:`, a diff of
  hand-written files), so being always-on costs nothing when they are wrong.

**A stripper claims the command, not a filename that contains its name.** `\bpnpm\b` matched
`node_modules/.pnpm/@cursor+sdk` and `':!pnpm-lock.yaml'`; `\bvitest\b` matched `cat _editor/web/vitest.setup.ts`.
Over one ledger window that was 90 of 318 pnpm claims and 66 of 266 test claims, and on four of them the stripper
reached into output it was never written for and deleted 2 KB of it. It also empties the **gaps** report, whose
whole question is which high-volume commands no handler claimed: a command wrongly claimed is a handler
opportunity hidden. The match is anchored the way `READ_COMMAND` is and for the same reason (below): a lookbehind
on `[\w.\-/]` rather than a statement start, so the quote, the `&&` and the line start all read alike.

Global stages are `dedup` (collapse ≥3 identical consecutive lines), `wide` (cut the middle out of a
machine-generated run), `cap` (head/tail truncation), and `redact` (mask secret-named assignments, AWS keys,
bearer tokens, URL creds: on both success and failure).

Two things `cap` and `redact` each learned the hard way, because both were measured wrong for a while and both
cost the model real information:

- **A deliberate read is not a log.** `cat`, `sed -n`, `awk`, `git diff/show`, `git log -p` get the Read tool's
  2000-line ceiling and are trimmed from the END; everything else gets head 30 / tail 50. What `READ_COMMAND`
  matches against is the LAUNCHER line (`nsenter … bash -c '…'`), not the shell statement: so it is anchored on
  a non-word character rather than a statement start. Anchored the other way it recognised `cd x && cat y` and
  missed a bare `cat y`, which over one day misread 88 of 93 shell reads as logs and gutted the middle out of,
  among others, five reads of the workspace README. Git's global options sit *between* the two words, so the
  verb is matched past them (`GIT_OPTIONS`): `git --no-pager diff` is the spelling this workspace's own
  instructions ask for, and without that it read as a log and came back as 81 lines of a 274-line diffstat.
  Six of those options take their value as a **separate word** (`-C`, `-c`, `--git-dir`, `--work-tree`,
  `--namespace`, `--exec-path`), where a `-\S+\s+` skip stops at the value and never reaches the verb: `git -C
  <path> diff` is how every cross-worktree command here is written, and the ledger caught it read as a log with
  a 252 KB diff of `_sandbox` coming back as 81 lines. The list is explicit rather than "any flag may take a
  value", because guessing that lets `git -C . log --oneline` swallow `--oneline` and match nothing.
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

- **A search hit repeats its file on every line.** `hits` is what `discover` named for a long time as the
  biggest remaining gap, and it was: one ledger window carried 1,523 search commands and 20 MB of raw output,
  with the repetition sitting in the results too small for `cap` to notice and too big to be free. The path is
  said once and that file's later hits are indented under it; nothing is summarised, so every line number and
  every matched line survives. Measured over **906 real search results** pulled from the session corpus:
  **15.3% smaller**, and a round-trip of all 906 recovers every `(file, line, content)` triple exactly. Over the
  whole corpus (89,709 Bash results) it removes **1.87 MB**, about eight times the next mechanism, and trips
  `guard` on 1.2 KB of it. It folds
  **consecutive** hits only and never regroups: gathering scattered ones buys another 0.9 points and pays for it
  by reordering the output, and a result whose line order is not the tool's own is a worse thing to hand a
  reader than a repeated prefix. The first hit of each file keeps its full `path:line:` spelling rather than
  becoming a bare header: it costs nothing (the header would have cost a line of its own) and it leaves every
  group headed by an anchor that can be copied straight into an editor.

- **A run is the unit, not a line, and not prose.** `wide` cuts the middle out of any unbroken run of 400+
  non-space characters: minified JSON, base64, a bundled-JS line, a `strings` dump. The RUN and not the LINE,
  because the two shapes share lines and no line-length threshold separates them: this repo's own README bullets
  pass 2,000 characters, and `git diff` of `contract.lock.json` puts a 5,941-character line on screen whose
  longest unbroken run is 546, because the generated JSON has English `description` values inside it. Sampling
  the corpus by band settles it: a blind line elision at >800 would have saved 4.17 MB and cut real prose in
  every band it touched; eliding runs saves **975 KB** and cannot touch a word. It fires only when the output is
  over the cap's byte budget: a run that fits is what the command was asked for (`jq -c`), and cutting it sent the
  agent back to re-run with other piping. It runs **after** `dedup`,
  because eliding two long lines' middles can leave them identical and dedup would then report as repeats what
  the command printed once each: and **before** `cap`, because a blob cut to its ends often brings the whole
  output back under budget, so the cap never has to drop a line at all.
- **A generated file's diff says one thing: that it changed.** `diff` folds the hunks of a lock file, bundle,
  source map or checked-in schema dump into `… N lines of generated-file diff elided (+A −B) …`, keeping git's
  own `diff --git` header so the reader still sees which file and how much. It is matched on the path in that
  header, never on the command, so it cannot reach a file the agent is actually editing. Worth **351 KB** over
  the corpus, more than every command-scoped cleaner and more than `cap` earns on the same replay: one real
  `git diff … contract.lock.json | head -40` goes from 36,042 bytes to 194. `wide` does **not** cover this case
  and the two are not substitutes.

**Add a cleaner:** append `{ id, match, apply }` (or a `strip(id, match, patterns)`) to `COMMAND_CLEANERS`:
omit `match` for a shape cleaner: and it joins `CLEANERS` automatically. Keep it dependency-free (the filter
must never break). Candidates surface from `discover` (below). Add the id to `CLEANER_OPTIONS` in
`_editor/web/src/features/sandbox/usage/savingsChart.ts` in the same commit: that list is what draws the switch on the
Agent tab and labels the mechanism's mark on the savings bar, and a cleaner missing from it saves tokens under
a name no screen can print.

**Deleting a cleaner is a normal outcome.** Eight command-scoped strippers (`npm`, `yarn`, `docker`, `git`,
`pip`, `lint`, `gh`, `build`) were removed after a corpus replay showed each removing *exactly zero* bytes over
10,682 real agent commands. A stripper that fires constantly and saves nothing is registry surface, a switch on
the settings page and a line in the ledger with no payer. `bench:cleaners corpus` is what settles the question.

## Toggle + benchmark

The active set is the **`outputCleaners`** per-sandbox setting (`.intentic/config/settings.json`), an iq-`--features`-style
spec:

- `""`: all cleaners on (**default**)
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
only whole-pipeline counterfactual. Four stages have no toggle: `ansi` (escapes/`\r` frames), `footer`, which is
**negative** (the retrieval pointer adds bytes, and it rides the same ledger as what it bought), `guard`, and `notes`
(negative too: what the filter says about the command rather than cuts from it, appended after `guard`).

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

Trimming is lossy display, lossless storage: when the footer is about to name it, the filter writes the run's
unfiltered text (ANSI stripped, redacted) to `logs/raw-output/<session>-<pane>.log`, keeping the newest 30 files and
the last 2M characters of each. The pane log is not the source: it is VT-rendered at pane width, so a long line comes
back wrapped into fragments. The footer prints a ready-to-run command (`… full: retrieve-output <file> [pattern]`)
and `retrieve-output` greps that file (case-insensitive, literal fallback), budget-capped to ~2000 tokens so
retrieval never re-floods context.

Two lines ride after the footer whatever the trim, because they correct what the result would otherwise say. An exit
0 whose last pipeline had an earlier stage fail reads `--- [exit 0 (pipeline: 1 0 — an earlier stage failed), 12s]`
(141, a writer cut off by `head`, is not a failure). And `rg -rn`/`-rl` gets a note that rg's `-r` is `--replace`:
that cluster rewrites every match to `n`, which agents read as the filter mangling their output.

**The two halves of the footer are priced separately, because they are worth different things.** The counts
(`--- [exit 0, 4s] 120 lines filtered to 81`) ride every trim: ~24 bytes, and they are what stops a trimmed
result being read as a complete one. The retrieval HANDLE is gated on `RETRIEVAL_MIN_DROPPED` (20 lines) or any cut
inside a line,
because it is ~100 of the footer's ~124 bytes and it used to ride every trim however small. Measured over one
two-day window: 551 handles cost 17k tokens, 15.7% of everything the cleaners saved on those same commands:
**86% of them explained a trim of under twenty lines**, and across 10,446 agent commands `retrieve-output` was
invoked **zero times**. Nobody goes back for three elided lines of pnpm progress. The gate recovers ~10.4k
tokens per window and spends at most ~1.8k of it back, because a counts-only footer is small enough to fit
under the never-worse rule on trims where the full one did not.

Note the corpus replay is the WRONG instrument for this one and says it is a wash: its inputs are transcript
tool-results, which already carry the footers the live filter wrote. Ledger and transcripts, not the corpus.

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

**It is back behind a flag (`INTENTIC_IQ_TURN_CONTEXT`), off, as a hypothesis rather than a decision.** Two
things happened after the removal. The module itself was restored ten minutes later by a commit that re-added
`turn-context.ts` and its test and nothing else (`738004971a`), so for months the workspace carried a fully
tested mechanism that nothing called. And the rebuild answers the two findings that killed it, which is the only
honest reason to re-measure rather than re-delete:

- **Delivery.** The median attempt outran its 3s deadline because every eligible turn paid one fused `q` — the
  semantic scan plus the cross-encoder. Now the evidence classes are typed and ordered by cost: a file the
  message names resolves through `outline` (SQLite), text it quotes through `find --literal` (rg), and the fused
  query runs only when neither fired. The expensive call is now the last resort instead of the only path.
- **Effect.** The old gate skipped retrieval entirely when the message named a file or path, which spent the
  strongest evidence a message can carry — the user had already localized the work. That case now resolves
  instead of bailing, and is the cheapest class to serve.

Neither argument is a result. It stays off until the same `iqSearchArm` coin flip and the same
`searchCalls`/`openingSearches` readings say something the first A/B did not, and "no effect again" is the
expected outcome worth planning for: the note costs a lookup and some of the turn's budget, so an indistinguishable
second reading is a reason to delete the module rather than to keep it flagged.

## What the report says: `/settings/savings`

`SavingsReport` is two families, deliberately never one ranking:

- `input` (the cleaners, from `filter-stats.jsonl`. Exact, windowed by UTC day. `gaps`) the un-cleaned
  commands worth a handler: is **grouped by command signature**, `commands` runs summing to `tokens`.
- `search`: the iq search teaching A/B, randomized per conversation. Two readings, `"searchCalls"` then
  `"openingSearches"`. Same `TurnExperiment` shape, same Welch machinery, same absence rule.

`TurnExperiment.metrics` is a head-and-tail tuple, not a plain list: one coin flip, one arm assignment, and N
readings over them: so the first is always the headline and a screen never has to check whether there is one.

**`gaps` prices what is LEFT, and it took three corrections to say that.** The row is weighed by `emittedBytes`,
grouped by the verb a cleaner would match on, and skips the verbs that hand back bytes the model named.

- **Raw bytes are the cap's receipt, not an opportunity.** Ranked by `rawBytes`, one live report's top five were
  a 122,145-token command that emitted **44**, a 78,715 that emitted 2,283, a 61,459 that emitted 554 and a
  15,241 that emitted 329: four commands whose whole cost `cap` had already removed, printed under a heading
  that asks for a handler. The one still costing the model 35,803 tokens ranked fourth.
- **Ad-hoc commands never repeat, so a command line cannot be a group.** Grouped by the literal line, 915 gap
  rows made 914 groups: the biggest had two runs and the rest had one, and the `×N` the screen prints to justify
  writing a handler could never be anything but `×1`. The signature is the verb, plus a subcommand for the
  fifteen verbs that have them (`git diff`, `pnpm install`): for everything else the second word is that run's
  own question (`rg displayName`, `rg fastModel`) and folding it in is what scattered them.
- **A deliberate read is not a gap.** `cat`, `sed -n`, `head`, `tail` and friends return exactly the bytes the
  model asked for by name; no handler will ever be written for them, and by emitted volume they outranked
  everything else two to one. Tested against the signature rather than the line, so `rg … | head -30` stays a
  gap in `rg` while `head -20 file` reads as what it is. Git's read verbs are deliberately not on that list:
  `git diff` prints what git decides to print, and what it decided was 36 KB of a lock file.

The web renders `input` as one stacked bar (mechanisms + what reached the assistant) on the Usage tab, where the
range window lives. Every experiment reading is drawn beside the switch that runs it, on the Agent tab, through
`MeasurementPanel.vue`: the verdict, the two arms as bars, and the holdout that split them. Note the ledger
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
