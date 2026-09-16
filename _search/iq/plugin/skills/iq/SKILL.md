---
name: iq
description: Workspace code search — one call from a question to ranked path:line anchors. Use for definitions, references, natural-language code questions, file skeletons, and git history.
---

# iq

Pick by what you already know:

- **You know the symbol you want to read** → `iq read X` — the body, one call. Read the file only when you need the whole file; a `Read` with no offset returns up to 2000 lines whether you wanted them or not.
- **You know the file** (stack trace, failing test) → `iq outline <path>` for its shape, then `iq read <path>::<symbol>`; `iq context path:line` when all you have is a line.
- **You know the symbol, but want its anchor or callers** → `iq def X` / `iq refs X` — one call, not grep-then-filter.
- **You don't know where it lives** → bare `iq "…"`. No separate verb for questions.
- **Checking your own edit** → `grep`/`rg`. Verification is not discovery.

```
iq "where do we enforce the secrets floor?"
```

| I want… | Run |
|---|---|
| natural language | `iq "how does auth refresh?"` |
| text/regex match | `iq find 'createServer\(' --lang ts` |
| where defined | `iq def createIgnoreScope` |
| who uses it | `iq refs createIgnoreScope --kind call` |
| file by name | `iq files wkignore` |
| file skeleton | `iq outline src/app.ts` |
| a symbol's body | `iq read createIgnoreScope`, `iq read src/app.ts::Server::start` |
| code around a hit | `iq context src/app.ts:48` |
| recent changes | `iq recent --since 2d` |
| git history | `iq log "MAX_MATCHES" --path src` |
| several at once | `iq multi "def foo" "refs bar"` |

Every answer opens with a capsule (`answer:`, `candidates:`, `more:`). Read that and stop — do not pipe through `head`; `--budget` already caps output. Scope with `--in`, `--repo`, `--lang`, `--glob`. Wrong grep habits (`iq search`, `iq ask`) are rewritten to `q`; use canonical forms next time. Full verb list: `iq --help`.

**Session recall:** `iq sessions grab "topic"` for ranked excerpts from past sessions; `iq sessions files "topic"` for files those sessions touched. Verify load-bearing hits against current code.

**Another conversation**, rather than what past sessions touched, is the `agents` CLI: `agents show <handle>` answers one whole (its task, where it got to, branch, worktree, delta, record) from any spelling of its name — id, branch, id prefix, session id, or title words. `agents ls` is the fleet, `agents find '<text>'` is who said a phrase. Never search `/history` by hand for one.
