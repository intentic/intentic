# iq / fileq usage audit, 2026-09-07

What 573 real invocations across 212 sessions (14 days, `~/.claude/projects/-work`) say about where the two
CLIs cost agents time and tokens. Extraction pairs every `Bash` tool_use whose command invokes `iq` or
`fileq` with its tool_result, so every figure below is measured, not estimated. 547 calls were `iq`; of the
26 `fileq` matches, none were a document read (see §J).

Two earlier rounds of this exercise are already visible in the source — `argv.ts` cites "207 calls",
`render/text.ts` cites "90% of answers piped through `head`". This round is against newer traffic and finds
the remaining defects are in the *ranking signals*, not the argument surface.

## A. `iq files` with no pattern produces a silent false negative

`iq files` alone exits 2 with a 30-byte message on **stderr**. The near-universal `2>/dev/null` habit (95%
of all calls redirect stderr) swallows it, so this shape:

```
iq files 2>/dev/null | grep -iE 'landing|website|marketing|homepage' | head -50
```

returns `(Bash completed with no output)`. The agent asked "does a file like this exist" and got back what
reads as an authoritative no.

Five confirmed instances in 14 days, e.g. searches for `computer.(ps1|sh)`, `fleet|AgentCard|AgentsView`,
`setup|login`, `subagent`. In each case the agent then reasoned from a false negative.

This is the only finding here that produces *wrong conclusions* rather than wasted tokens, so it should go
first regardless of frequency.

Fix: `iq files` with no positional should list ranked paths rather than error — the verb has an obvious
zero-argument meaning. Failing that, usage errors belong on stdout, where a redirect cannot eat them.

## B. Confidence is measured on passages, not on answers, so two thirds of answers say "ambiguous"

Of 390 answered queries, 255 (65%) are labelled `ambiguous` and 101 (26%) `confident`.

`dispatch.ts:462` computes the margin as the sigmoid gap between the top two *reranked passages* out of
`RERANK_TOP = 32` candidates. Those candidates are individual hits, and multiple hits from one file
routinely resolve to the same chunk — `chunkAt(db, hit.path, hit.line)` hands the cross-encoder the
identical passage text, which scores identically, which drives the margin to ~0. A file that matches well
in two nearby places is therefore *penalised* into "ambiguous" for matching well twice.

The margin is also taken on raw rerank logits while the displayed order comes from the RRF blend of fused
rank and rerank rank (`dispatch.ts:440`). The confidence the agent reads is not about the ranking the agent
sees.

Live demonstration:

```
iq "renderText budget reservation capsule"
answer: intentic/_search/iq-engine/src/render/text.ts:241 · renderText (fn) · ambiguous
```

Rank 1 is exactly right — that file *is* `renderText`, and the budget reservation is in it. Rank 2 was
`webq/plugin/skills/webq/SKILL.md`. That field is not flat by any reading; the passage-level margin just
cannot see it.

This is what drives hedging: 113 of 573 calls (20%) run `rg`/`grep`/`find` in the same shell command as the
`iq` call. The comment at `dispatch.ts:507` says "ambiguous" is meant to point at the candidates rather than
out into a grep spiral. Against this traffic it does the opposite, because it fires on correct answers.

Fix: compute the margin between the top group and the second **distinct-path** group, under the blended
order that actually determines output. Deduplicating by chunk id before scoring would also work and is
cheaper.

## C. The `answer:` anchor lands on a meaningless line about a third of the time

`answerLine` (`render/text.ts:98`) anchors at `bestHit(group)` — the highest-scoring *line*. Line scores
peak inside a symbol, not at its declaration, so the anchor lands on `continue;`, a closing brace, or a
comment. Of 210 answers whose anchor line was resolvable in the same output, 65 (31%) point at a
syntactically trivial line.

In the live example above the anchor is `text.ts:241` (`if (candidates.length > 0) {`) for a query about
budget reservation, which is at line 141, in a function declared at line 119. The anchor is 100 lines off.

The fix is nearly free: `enclosingSymbol` (`dispatch.ts:126`) already returns `{ name, kind, line, endLine }`
and `enrichContext` throws the line away, keeping only `"name (kind)"` for display. Keep the declaration
line and anchor the answer there when a symbol encloses the hit, with the hit line as the secondary.

## D. `candidates:` is the largest single line item, and it is mostly noise

18% of all `iq` output bytes, roughly 54,000 tokens over the 14 days. `CANDIDATE_COUNT = 12` paths are
emitted unconditionally on every `hits`-style answer, with no score and no reason attached.

27% of the 2,186 candidate paths sampled are tests, docs or marketing copy. From the live probe above, the
12 candidates for a query about `renderText` included a `SKILL.md`, `_tools/nav/baselines/surface.json:8761`,
two unrelated agent-board chips, and a webext store-asset script. None relate to the query.

The line was added because "the true answer often sits at rank 5–13" — a real problem. But emitting twelve
paths at a fixed count regardless of score means the tail is padding whenever the tail is empty.

Fix: gate on score rather than count (drop candidates below a rerank floor), and skip the line entirely when
confidence is `confident`. Fixing §B first makes the second half of that cheap, because `confident` would
then be the common case.

## E. Repeated path prefixes cost 13% of output — but only a sixth of that is recoverable

Path text is ~38,000 tokens over 14 days, 13% of output. That figure counts every occurrence of a path
prefix, which is what made it look like an opportunity.

It mostly is not. Measured against the 363 real `candidates:` lines in the sample, factoring out the longest
common prefix saves **11%** of the line, and grouping paths by directory and naming each directory once saves
**16%**. Candidates genuinely span many directories, so nearly every prefix occurrence belongs to a distinct
file the agent might open — it is the file's only mention, not a repeat. Hit lines never carry the path at
all (`  543: text`), so there is nothing to strip there.

16% of the candidates line is ~8,600 tokens a fortnight, in exchange for a less scannable output format.
**Not worth doing.** Recorded here so the next audit does not re-derive the same tempting 13% and re-open it.

## F. `iq --help` is 8.8 KB of mostly one repeated string

The USAGE block is 4.8 KB and repeats the identical 15-flag list on all 16 verb lines. Whole output is about
2,200 tokens; 24 calls in 14 days is roughly 53,000 tokens, nearly all of it the same substring.

Fix: one shared "common flags" block, then per-verb lines carrying only the verb-specific flags
(`--literal --word --case` for `find`, `--kind` for `refs`, and so on).

## G. The always-on nudge omits the one rule that would stop `head`

96% of calls (552/573) pipe `iq` through `head`. In 54% of those the output actually reached the cap, so
`head` is really truncating. `--budget` — which does the same job without cutting mid-structure, and which
the renderer reserves the capsule against — was used 17 times against 559 uses of `head`.

`SKILL.md` states the rule ("do not pipe through `head`; `--budget` already caps output"). `nudge.txt` does
not, and `nudge.txt` is what every session gets: it is the SessionStart injection, and per
`iq-search-instruction.ts` it is *the entire teaching payload* for Codex and OpenCode, which have no plugin
seam. The one line that would fix the habit is in the document most agents never open.

Fix: add the `--budget` sentence to `nudge.txt`. Cheapest item in this document.

## H. Absorber gaps: 21 hard failures, each a wasted round trip

`argv.ts` already makes the "a rewrite costs nothing, a redirect costs a turn" trade for `search`,
`skeleton`, `ask`, `--include`, `--max-results`, `--path`. These shapes still cost a turn:

| Shape | Response | Should be |
|---|---|---|
| `iq sessions "<query>"` | `No command registered for '<query>'` | `iq sessions grab "<query>"` |
| `iq sessions show <id>` | `No command registered for 'show'` | list/grab that session |
| `iq context <path>` (no `:line`) | `expected an anchor like path:line` | `path:1`, or run `outline` |
| `--lines 80` | `did you mean --limit?` | `--context-lines 80` |
| `iq index --status` | `did you mean 'status'?` | run `status` |

`iq sessions "<query>"` is the most frequent (4 occurrences) and the most defensible mistake: `iq "<query>"`
searches, so `iq sessions "<query>"` reading as "search sessions" is the obvious inference. The `--lines`
case is worse than a miss — the edit-distance suggestion names `--limit`, which is not what the agent meant;
`--context-lines` is.

`normalizeArgv` only rewrites `argv[0]`, which is why nothing reaches the `sessions` subroutes.

## I. `iq` disappeared sandbox-wide for about 30 minutes

On 2026-09-02 between 17:34 and 18:04, five separate sessions got `bash: iq: command not found`. Two tried
`pnpm exec iq` and got `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`. All fell back to `rg`.

Five sessions in one 30-minute window is an outage of the baked symlink or its target, not five coincidences.
Worth finding out what happened; separately, `command not found` teaches the agent nothing, and a shim on
PATH that explains how to recover would turn a dead turn into a working one.

## J. fileq is not being used to read anything

None of the 26 `fileq` matches is a document read in the course of ordinary work. They are sessions
developing fileq itself (2026-08-29, 2026-09-07), `which fileq`, `fileq --version`, one `fileq sweep --json`,
and `rg` for the string "fileq".

This is mostly corpus, not product: the workspace holds 6,467 images (overwhelmingly app icons and
Playwright screenshots) and 60 documents, and nearly every document lives under `refs/`, which is excluded
from indexing on purpose. 393 sidecars exist, mostly for PNG icons.

One gap is real, though. Sidecars live at `.intentic/local/cache/derived/<path>.md` and are designed to be
read back with a plain `Read` — but nothing points an agent at them. An agent that `Read`s a PDF gets the
harness's own PDF handling and never learns a derived markdown shadow was sitting there. A one-line note in
the nudge, or a `Read` interception that redirects to a fresh sidecar, would close it.

## Is rg already doing this job? Mostly, and that is the finding

Measured over the same 212 sessions, counting only sessions that used `iq` at least once, so `iq` is not
being compared against a population that never adopted it:

| | calls | share of Bash | output | empty results |
|---|---|---|---|---|
| `rg`/`grep`, tree discovery | 7,697 | 33% | 12.9 MB (~3.2M tok) | 10.1% |
| `rg`/`grep`, pipe filter | 1,508 | 7% | 1.3 MB (~313k tok) | — |
| `iq` / `fileq` | 584 | 2.5% | 1.9 MB (~480k tok) | 3.1% |
| `Read` (native tool) | 3,945 | — | — | — |

`rg` outruns `iq` **13:1 on discovery alone**, and per call it is the better citizen: 1,466 bytes against
iq's 3,278. Anyone arguing iq is unnecessary has the volume on their side.

The cost is not in the call, it is in the chain. **98.6% of rg calls happen within two minutes of another rg
call** (10,765 of 10,918). Chain lengths: 174 of length 2, and 388 chains of ten or more, longest 72. In
1,208 cases an empty rg result was followed by another rg inside two minutes — the guess-again loop, running
about twice per session.

That is the honest shape of it. `rg` answers "which lines contain this string" perfectly and instantly, and
an agent that knows the string should absolutely use it. What it cannot answer is "where is X handled",
which is why the answer arrives as a six-call median guess-refine loop with a one-in-eight chance each guess
returns nothing.

**So iq's value is not replacing rg. It is collapsing that chain into one call — and it is currently
capturing 2.5% of the traffic where that would pay.** Which reframes this whole audit: iq's internal
efficiency is worth less than iq's adoption, and the two findings that move adoption are §B (an answer
labelled ambiguous two thirds of the time is one an agent hedges against) and §G (the nudge every session
reads omits the budget rule). Neither is a token-trimming exercise.

## Worth considering: expose iq as a tool, not a shell command

First, the thing worth knowing before designing anything: **`/workspace/search` already is iq.** The route
handler calls `services.iq.run(...)`, and its own comment says it runs "the resident iq engine in-process
(services.iq), same engine the agent's Bash `iq` calls use, minus the per-query process spawn, workspace
sweep, and inline revalidation those pay." It renders in `list` mode — rows for a GUI rather than a token
capsule — but the retrieval is identical. An MCP tool over that contract is a second front door on one
engine, not a second retrieval stack, and it would be strictly cheaper than the CLI: process spawn plus
module load alone measures ~360 ms per call, which is the one timing figure here worth quoting (the box was
at load 37 during this audit, so wall-clock query numbers are not reportable).

Be clear about what it would and would not buy. Most of what this audit found is shell-surface tax rather
than retrieval failure:

- 95% of calls redirect stderr, which is what makes §A silent.
- 96% pipe through `head`, which is what fights the budget in §G.
- 46% prefix `cd`, paid for by `rootRelativePath` resolving three frames per path.
- All 21 hard failures in §H are argument-shape errors that a typed schema cannot express.

The retrieval engine is good — rank-1 was correct in every live probe run for this audit. What costs turns
is the string-to-argv seam in front of it, and a typed surface removes that seam by construction: no
stderr to redirect away, no `head` to fight the budget, no flag to guess because the schema is in the
prompt.

But it fixes the *failure modes*, not the *retrieval*, and the retrieval is what decides whether an agent
trusts the answer enough to stop hedging. §B and §C are engine-side and survive any transport. **Do those
first; the MCP tool is the second-order win.** Shipping it against a confidence signal that says "ambiguous"
two thirds of the time would just make a hedged answer cheaper to fetch.

The CLI should stay regardless: it composes, it is what a human types, and non-MCP harnesses need it. But
the hot path — a natural-language question against the workspace — has no reason to be a string parsed
twice.

## Ranked by measured cost, and what was done

| # | Finding | Cost over 14 days | Status |
|---|---|---|---|
| A | `iq files` silent false negative | 5 wrong conclusions | fixed |
| B | Confidence fires on correct answers | 65% ambiguous → 113 hedged calls | metric fixed, threshold unvalidated |
| C | Trivial answer anchors | 31% of anchors | fixed |
| H | Absorber gaps | 21 wasted turns | fixed |
| G | Nudge omits `--budget` | drives the D/F waste | fixed |
| D | `candidates:` padding | ~54k tokens | open, needs the bench |
| F | `iq --help` repetition | ~53k tokens | open |
| E | Repeated path prefixes | ~8.6k tokens recoverable | closed, not worth it |
| I | 30-minute `iq` outage | 5 sessions degraded | open |

### What changed

- **A** — `iq files` takes an optional positional (the shape `recent` already had); no pattern lists the tree
  instead of exiting 2 onto a stderr nobody reads. A `hint:` names the pattern form, because the listing is
  budget-truncated and `| grep` strips the header that said so.
- **B** — `fieldMargin` in `dispatch.ts` compares the top two **files** of the displayed order instead of the
  top two passages. Two hits in one file resolve to one chunk, so the old metric scored the same text twice
  and read a file's own second hit as its rival.
- **C** — `EngineHit.contextLine` carries the enclosing symbol's declaration line, which `enrichContext`
  previously computed and threw away. `answer:` anchors there and names the match line beside it.
- **H** — `normalizeArgv` absorbs `sessions "<query>"` → `sessions grab`, `index --status` → `index status`,
  `--lines`/`--context`/`--before-context`/`--after-context` → `--context-lines`, and a bare `context <path>`
  → `outline`. It was also split into one named absorber per rewrite; it had grown past the complexity limit.
- **G** — `nudge.txt` gained the capsule-and-`--budget` rule that only `SKILL.md` carried.

Verified live before an unrelated environment failure (below): the anchor for the audit's own demo query
moved from `text.ts:241` (`if (candidates.length > 0) {`) to `text.ts:119 · renderText (fn) · match :241`.

### B is half-done, deliberately

The metric now measures the right thing, but the answer for that demo query is still labelled `ambiguous`.
`CONFIDENCE_MARGIN` is an absolute 0.05 gap on sigmoid scores that ms-marco compresses into a narrow band
around 0.2 for code — so an absolute threshold is the wrong shape, and a relative one (gap over top score)
probably fits. That is a ranking change, `iq-bench` exists to grade exactly this, and tuning it by eye
against one query would be guessing. The same applies to **D**: the bench counts `candidates:` anchors as
openable hits, so trimming the line trades tokens against measured recall and needs a before/after run.

### Environment note, and it is the same failure class as I

Mid-audit, four `@ast-grep/lang-*` packages in this worktree's pnpm store became **hollow directories** —
present, empty. The iq-engine suite went from 35 files / 194 tests passing to 19 files failing, every one on
`Cannot find package '@ast-grep/lang-go'`, and `verify:turn` failed the same way at the declaration-emit step.
Nothing in this change touches `indexer/languages.ts`, where all four imports live.

Repaired in place. `/opt/sandbox/node_modules/.pnpm/` — the image's own tree, which the baked `iq` on PATH
runs from — held the identical versions (`lang-go@0.0.6`, `lang-java@0.0.7`, `lang-python@0.0.6`,
`lang-rust@0.0.7`), so restoring the empty directories was a same-version copy: no resolution, no lockfile,
no manifest. Suite back to 36 files / 203 tests, `verify:turn` green.

Two things worth keeping from it. `mcp__deps__status` reports `intentic: ready` throughout and
`mcp__deps__install` declines to queue, because both read manifest drift rather than store integrity — a
package directory that exists and is empty is invisible to them. And the failure surfaced four layers from
its cause: as a TS2307 in a file nobody had edited.

Worth connecting to **I**: that is twice now that iq has been broken by its install rather than its code.
The one bright spot is that iq says so properly — `iq: this is a broken install, NOT an empty result, do not
read it as 0 hits or fall back to grep silently`. That sentence is exactly the discipline finding **A** was
missing, and it should be the model for every zero-result path in the tool.
