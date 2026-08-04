---
name: iq
description: Workspace code search — the fastest route from a question to `path:line` anchors when you don't already know where to look. One Bash call returns ranked, token-budgeted results. Use for "where is X defined/used", natural-language code questions, structural AST patterns, file skeletons, and git history.
---

# iq — one search tool, intent-first

Pick by what you already know:

- **You know the file** (failing test names it, stack trace has a path) → Read it directly; `iq context path:line` / `iq who path:line` for surroundings. Searching is overhead here.
- **You know the exact identifier** → `iq def X` / `iq refs X` — one call replaces a grep-then-filter chain.
- **You don't know where it lives**, or your words may not match the code's vocabulary → bare `iq "…"`. Ask it as a question; there is no separate verb for natural language. This is where iq decisively beats grep.
- **You have error-message text** → `iq find 'literal text'`, then `iq context` on the hit.
- **You are already in the code, checking one thing** — did my edit land, does that string still appear, is this import gone → plain `grep`/`rg`. Verification is not discovery: measured over 18k real search calls, iq's advantage is concentrated in the opening half of a turn (it sends you into a file 27.7% of the time against grep's 16.8%) and has disappeared by the second half (9.2% against 8.3%), where it still costs about twice the output per call. Reach for it to find your way, not to confirm what you already know.

```
iq "where do we enforce the secrets floor?"
```

| I want… | Run |
|---|---|
| text/regex match | `iq find 'createServer\(' --lang ts` — rust regex: alternation is `a\|b` (never backslash-pipe); literal text: `--literal` |
| a file by name | `iq files wkignore` (`--exact` for globs) |
| where X is defined | `iq def createIgnoreScope` |
| who uses X | `iq refs createIgnoreScope --kind call` |
| symbols by pattern | `iq sym 'Workspace*Schema' --kind type` |
| structural pattern | `iq ast 'await $FN($$$)' --lang ts` |
| natural-language answer | `iq "how does the daemon expose tools?"` — bare query, no verb |
| a file's skeleton | `iq outline src/workspace/workspace-ignore.ts` |
| code around a hit | `iq context src/workspace/workspace-tree.ts:48` |
| recent changes | `iq recent --since 2d` |
| history of a string | `iq log "MAX_TOTAL_MATCHES" --path src/workspace` |
| blame a line | `iq who src/file.ts:15` |
| several queries, one spawn | `iq multi "how is auth refreshed" "def refreshToken"` — one query per argument |

If a hard question misses on the first try, rephrase 2–3 ways in ONE spawn — you are the best query rewriter:
`iq multi "how is auth refreshed" "token renewal flow"` (not by default — it costs tokens).

## Read the top of the answer, then stop

Every answer opens with a capsule, before any code, so `head`/`sed` never cut the part that matters:

```
iq: <query> — 87 hits in 23 files · index fresh (0.4s) · reranked · showing 42/87
answer: _libs/engine/src/title-summary.ts:31 · titlePrompt (fn) · confident · [sem 0.71] [bm25 1.00]
candidates: naming.ts:14 · session-store.ts:207 · …      ← ranked anchors that did NOT fit
related: titlePrompt — def title-summary.ts:31 · called from session-name.ts:88
more: 45 hits in 12 files — iq <query> --after 3f9a2b1   ← the exact continuation command
════ _libs/engine/src/title-summary.ts (34) ════        ← code starts here
```

- `answer:` is the top-ranked anchor with its enclosing symbol. `confident` means the top result stands out —
  take it and move on. `ambiguous` means the field is flat — scan `candidates:` before committing.
- `candidates:` are `path:line`, not bare paths: open one directly instead of searching inside it again.
- `related:` already names the strongest **caller** of each answer symbol — that is the `iq refs` you would
  have run next, so don't run it unless you need the rest of the call sites.
- Natural-language answers carry the **top hits' full enclosing bodies as live file lines** at their real line
  numbers. That code is the answer; re-opening the file with Read usually adds nothing.
- Don't pipe through `head` to save tokens — `--budget` already does that, and it keeps whole groups intact.

Scope with `--in <dir|file>`, `--repo <name>`, `--lang ts,py`, `--glob`/`--not-glob`,
`--only tests|src|docs|config`; `--ignored` includes gitignored files (secrets stay unreachable).
Exit codes: 0 hits, 1 none, 2 usage error. The index self-manages — run `iq index rebuild` only if results look
stale. A header saying the index is N files behind still has live text matches; only symbol line numbers lag.

Don't work around the interface — it bends toward you:

- **Paths in any frame.** `--in` and `outline`/`context`/`who` take cwd-relative, absolute, or workspace-relative
  paths, and `--in` accepts a single file. A path that matches nothing is a loud error naming what was tried,
  never a silent zero.
- **grep vocabulary is absorbed.** `iq search …` and `iq ask …` both run `q`; `--include`/`--path`/`--max-results`
  map to `--glob`/`--in`/`--limit`. A note on stderr names the canonical form — use it next time, don't retry.
- **`find` recovers bad patterns.** A pattern rust regex rejects (`foo({`) reruns as literal text; grep-style
  escapes (`a\|b`) rerun rewritten. The header says which ran, so a wrong pattern costs no extra turn.
- **A name that isn't there still gets answered.** When an identifier, path or pattern matches nothing exactly,
  the query is re-run semantically and the header says so — a miss is not a wasted turn, so don't fall back to grep.

## Session recall

Past Claude Code sessions of this workspace are indexed (each user turn's prompt, the answer it got, and
which files it touched):

| I want… | Run |
|---|---|
| conversation excerpts on a topic | `iq sessions grab "auth refresh"` — ranked asked→answered fragments from past sessions, budgeted |
| files past sessions touched for a topic | `iq sessions files "auth refresh"` — complements content search: association, not text match |
| recent sessions | `iq sessions list [query]` |
| sessions related to a prompt | `iq sessions match "<prompt>"` |
| continue from a past session's context | `iq sessions fork <sessionId> [--at <turn>]`, then `claude --resume <printed id>` |

When the user references something discussed in a previous chat that isn't in the current conversation,
reach for `iq sessions grab` before asking them to repeat it. Excerpts are statistical recall over old
transcripts — verify anything load-bearing against the current code before acting on it.

When a hook reports "a related past session exists" on the user's first prompt (with excerpts from it),
relay the suggested `iq sessions fork …` command to the user and let THEM decide — never fork on their
behalf. A fork copies the session up to that turn under a fresh id; its staleness report lists files changed
since — re-read those before trusting remembered contents.
