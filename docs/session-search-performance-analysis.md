# Why searching past sessions by phrase is slow

Measured on this live sandbox, 2026-08-21, against the real corpus on `/history`
and `/work/.intentic/records/sessions`, plus the daemon's own slow-request log
(`/history/logs/daemon.log`). Every number below was produced by running the
actual code paths over the actual data, not inferred from reading code.

The corpus, for scale:

| store | count | bytes |
| --- | --- | --- |
| fleet registry entries (`/history/agents.json`) | 1418 | 2.1 MB |
| daemon transcript records (`/history/transcripts/*.jsonl`) | 1253 | 545 MB |
| SDK session files (`records/sessions/claude/projects`) | 695 | 1589 MB |
| SDK sessions in the workspace root project (`-work`) | 677 | — |
| spoken lines extracted from all records | 30 572 | 12.1 M chars |

## The headline

The `/agents` filter is slow for **one structural reason with five multipliers**.
The structural reason: **the search index is built on the query path**, so the
first phrase search after boot pays for reading and parsing ~670 MB.

The daemon's own log agrees, and is worse than the bench:

| route | n (over the 300 ms floor) | p50 | p90 | max |
| --- | --- | --- | --- | --- |
| `/sessions` (phrase search) | 6 | **19 089 ms** | 26 777 ms | 26 777 ms |
| `/agents/search` | 5 | **17 565 ms** | 23 507 ms | 23 507 ms |

Only requests crossing the 300 ms slow floor are logged, so this is the tail, not
the mean. But when a search crosses that floor it crosses it by 60×, and both
routes fire together on the same event loop, so they queue behind each other and
behind every turn frame, transcript read and roster poll in flight.

## What one keystroke costs

`useAgentFilter` debounces 150 ms, then fires **two** requests in parallel:

- `GET /agents/search` → scans all 1418 registry entries, live and archived
- `GET /sessions?query=` → scans the 50 newest SDK sessions

Each entry needs its spoken lines. Cold, that means reading the store.

### Cold: the first search after boot

| step | measured |
| --- | --- |
| `listSessions({dir, limit: 50})`, cold page cache | 2 360 ms |
| `getSessionMessages` × 50 (124 MB of session files, one 42 MB) | 8 140 ms |
| read + `JSON.parse` + validate 1253 records (545 MB, 33 812 rows) | 2 580 ms |
| **total blocking work before the first answer** | **≈ 13 s** |

Breakdown of that 2 580 ms: 1 320 ms file read, 610 ms `JSON.parse`, 130 ms
`RestoredMessageSchema.safeParse`. Schema validation is *not* the problem;
reading half a gigabyte is.

The route fans this out with an unbounded `Promise.all` over 1418 entries, so all
545 MB is in flight at once and every `JSON.parse` blocks the loop in turn. This
is the "multi-second event-loop stalls" the comment in `agent-transcript.ts`
already describes — the cache it added fixed the *repeat*, not the first hit.

### Warm: every keystroke after that

| step | measured |
| --- | --- |
| 1253 `record.size()` stat probes | 6.5 ms |
| `matchLines` over 30 572 spoken lines, worst case | 104 ms |
| `listSessions` warm | 42–128 ms |

So ~150 ms of *blocking* loop time per settled keystroke, forever. The stat storm
is cheap; the scan is not.

## The five multipliers

**1. The scan re-normalizes immutable data on every keystroke.** `windowed()`
runs `text.replace(/\s+/gu, " ").trim()` and `.toLowerCase()` per line, per
query. That is 12.1 M chars of regex work and string allocation for a result that
can never change: lines are append-only and normalized identically every time.

**2. No prefilter.** Every conversation is scanned even when the query provably
cannot be in it. A query matching nothing costs the same as a query matching
everything — in fact *more*, because there is no early exit.

**3. No prefix narrowing.** Substring matching is monotone: whatever matches
`authe` is a subset of whatever matches `auth`. Typing a word re-scans the whole
fleet on each settled keystroke instead of narrowing the previous candidate set.

**4. Cancelled queries keep running.** The browser threads an abort signal
(`keepPreviousData` + TanStack), but `agents.routes.ts` `search` never reads it.
The `workspace.routes.ts` `search` handler *does* (`handler(async ({ input,
signal })`). So a superseded fleet query scans all 1418 entries to completion,
and a keystroke burst queues N full scans nobody is waiting for.

**5. Two round trips, two caches, one corpus.** `/agents/search` caches through
`createSpokenLinesReader` (keyed on record byte size); `/sessions?query=` caches
through the module-level `stored` map in `transcript-search.ts`, which is never
invalidated and never evicted. A conversation that is both a fleet card and a
listed session is extracted and held twice.

Memory, measured: the spoken-line cache is **24 MB of heap for 1254
conversations**, held for the life of the daemon, plus the unbounded session map
beside it.

## What the fixes are worth

Measured over the same 1253 conversations / 30 572 lines.

| query | today | pre-normalized | + trigram gate |
| --- | --- | --- | --- |
| `zzqqxx-no-match` (0 hits) | 104.3 ms | 6.4 ms | **0.8 ms** |
| `authentication` (19 hits) | 100.8 ms | 12.0 ms | **8.2 ms** |
| `worktree` (476 hits) | 63.6 ms | 5.2 ms | **2.6 ms** |
| `the` (1206 hits) | 15.1 ms | 1.1 ms | **0.9 ms** |

- **Pre-normalize at ingest** (collapse + fold once, in `spoken()`): ~10×. Costs
  one extra folded copy per line, so the 24 MB cache becomes ~36 MB.
- **Trigram gate** (a 4096-bit bitset per conversation, ~512 B each): a further
  2–8×, and it is *most* effective exactly where today is worst — a rare phrase
  that matches nothing.

Typing `authentication` one character at a time, 12 settled keystrokes:

| strategy | total |
| --- | --- |
| full rescan per keystroke | 130 ms |
| narrow from the previous prefix | **22 ms** |

None of that touches the 13 s cold path. This does:

### The structural fix: persist the index

`node:sqlite` here ships FTS5 **with the `trigram` tokenizer**, which is exactly
a substring/phrase index.

One trap worth recording, because it is a silent correctness regression rather
than a slowdown: **sqlite's own case-insensitivity is ASCII-only.** With the text
stored as written, `LIKE '%ärger%'` does not find `Ärger im Büro`, which the
JS `toLowerCase()` scan did find. So the searchable column is folded by JS on the
way in and the needle is folded by JS on the way out; the text as written rides
along un-indexed, for the snippet only. That costs ~18% on the index size and is
not optional.

## What was built

All of the above is implemented. `sessions/search-index.ts` is the index,
`sessions/search-backfill.ts` fills it, and both search routes read it.
Re-measured on this workspace with the shipped code (1259 conversations,
30 721 spoken lines):

| property | measured |
| --- | --- |
| backfill, cold, whole workspace | 20.4 s, once, detached and paced |
| index on disk | 73 MB |
| query `zzqqxx-no-match` | **12.8 ms** |
| query `authentication` | **21.2 ms** |
| query `worktree` (476 hits) | **23.7 ms** |
| query `the fleet board` | **26.8 ms** |
| query `ci` (2 chars, 989 hits) | **34.6 ms** |
| query `landAgent`, match-case | **17.8 ms** |
| index one settled turn | **2.9 ms** |

Two of those numbers differ from the prototype above and the difference is
honest: the backfill is 20.4 s rather than 4.4 s because the real path runs
schema validation per row and the full extraction pipeline (preamble stripping,
attachment notes, runtime-handoff unfolding) per message, and queries are
13–35 ms rather than 0.1–9 ms because of the JS-folded column the Unicode fix
requires. Both are paid where they belong: the backfill is detached and yields
between sources, and 20 ms is a keystroke, not a stall.

The precedent is in-repo: `_search/iq-recall` already indexes Claude Code
transcripts with `node:sqlite` for `iq sessions`. That package is deliberately
walled off inside the iq dependency island and is not imported by the daemon —
but it established the pattern, the tokenizer choice and the ingest shape.

### What else shipped, and what did not

- **The session list is cached** for 400 ms behind an injected factory, so a
  keystroke burst costs one stat pass over the session store instead of one per
  query. It is a factory rather than a module-level cache so it cannot leak
  between callers and a suite can get a straight answer out of it.
- **`transcripts.lines` and its 24 MB heap cache are gone**, along with the
  per-query whitespace regex: `spoken()` normalizes once, at construction, which
  is also what makes the index and the in-memory overlay agree character for
  character.
- **The write-lag overlay stayed.** The index is written when a turn *settles*,
  so the prompt you just sent — the one you are most likely to search for — is
  covered by a small in-memory list that a search unions in.
- **The abort signal was not added**, and the reason is that the fix removed the
  thing it would have protected: the handler is now one query with no per-entry
  async work, so there is no multi-second scan left to cancel mid-flight.
- **Prefix narrowing was not built.** It was a 6× win on a path the index makes
  20 ms; it would be complexity bought after the fact.
- **Results are not streamed.** Same reason. Streaming was worth it against a
  19 s scan so the first hit was usable early; against 20 ms there is no early.

## Should the search signal progress? (and what was done)

**Yes, but not as a progress bar, and not as a substitute for the fixes above.**

What exists today is one boolean. `useAgentFilter` exposes `searching` (true
while the debounce runs *or* a request is in flight) and `AgentsView` binds it to
`SearchBar`'s `busy`, which spins an icon. Over a 19 s search that spinner
conveys nothing: not how far along, not how much is left, not whether the list
under it is complete.

That last one is the actual defect, and it is a correctness problem rather than a
cosmetic one. Matching runs in two tiers: the browser matches open conversations
and titles locally and instantly, then merges the daemon's answer when it lands.
For the 19 s in between, **the board shows a confident, complete-looking list
that is missing every conversation this tab never opened and the entire archive**
— and the tally beside it reads `"N of M"`, which asserts completeness. A user
who searches, sees three results and moves on has been given a wrong answer with
no indication it was provisional.

So the two things worth building, both of which stay true after the index lands:

- **Say which tier answered.** While the daemon half is outstanding: "Showing
  open chats — searching the rest…", and suppress or mark the `"N of M"` tally.
  This is a few lines in `AgentsView` and it converts a wrong answer into an
  incomplete one.
- **Stream results as they arrive** rather than answering all-or-nothing. Results
  appearing progressively is better feedback than any percentage, and it means a
  slow scan is still usable from its first hit.

A percentage-complete bar is the thing to avoid. The route already returns
`scanned`, so it would be easy to wire — and it would be the wrong move: it
makes 19 s feel accounted for instead of fixed, and once the search is 20 ms
there is nothing left to report. Signal *what the answer covers*, not how long
it is taking.

**Built:** the coverage signal, not a bar and not streaming.
`/agents/search` now returns `indexing`, true while the backfill is still
filling the index, which is the only remaining state in which an answer can grow
after it arrives. `useAgentFilter` folds that together with "the daemon has not
answered for what is currently typed" into one `partial` flag, and while it is
set the board's tally stops counting: `"3 of 40"` becomes
`"searching the rest…"`, and the `"no matches"` empty state is suppressed
outright, since that is the one message a half-finished search must never show.

The spinner on the field is unchanged and still means "a request is in flight".
The tally is what changed, because the tally was the part that was lying.
