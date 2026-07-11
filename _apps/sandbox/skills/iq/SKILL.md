---
name: iq
description: Workspace code search — the fastest route from a question to `path:line` anchors when you don't already know where to look. One Bash call returns ranked, token-budgeted results. Use for "where is X defined/used", natural-language code questions, structural AST patterns, file skeletons, and git history.
---

# iq — one search tool, intent-first

Pick by what you already know:

- **You know the file** (failing test names it, stack trace has a path) → Read it directly; `iq context path:line` / `iq who path:line` for surroundings. Searching is overhead here.
- **You know the exact identifier** → `iq def X` / `iq refs X` — one call replaces a grep-then-filter chain.
- **You don't know where it lives**, or your words may not match the code's vocabulary → bare `iq "…"` or `iq ask "…"` — this is where iq decisively beats grep.
- **You have error-message text** → `iq find 'literal text'`, then `iq context` on the hit.

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
| natural-language answer | `iq ask "how does the daemon expose tools?"` |
| a file's skeleton | `iq outline src/workspace/workspace-ignore.ts` |
| code around a hit | `iq context src/workspace/workspace-tree.ts:48` |
| recent changes | `iq recent --since 2d` |
| history of a string | `iq log "MAX_TOTAL_MATCHES" --path src/workspace` |
| blame a line | `iq who src/file.ts:15` |
| several queries, one spawn | `iq multi <<'EOF'` … one per line … `EOF` |

If a hard question misses on the first try, rephrase 2–3 ways in ONE spawn — you are the best query rewriter:
`iq multi <<'EOF'` … `ask how is auth refreshed` / `ask token renewal flow` … `EOF` (not by default — it costs tokens).

Every hit is a `path:line` anchor you can Read directly; hits show their enclosing symbol (`⟨in createWidget (fn)⟩`)
and `ask` appends `related:` definition anchors. Output fits `--budget` (default 1500 tokens);
truncation footers print the exact `--after <cursor>` command to continue. Scope with `--in <dir>`,
`--repo <name>`, `--lang ts,py`, `--glob`/`--not-glob`, `--only tests|src|docs|config`; `--ignored` includes
gitignored files (secrets stay unreachable). Exit codes: 0 hits, 1 none, 2 usage error. The index
self-manages — run `iq index rebuild` only if results look stale.
