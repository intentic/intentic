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
- **You have text off a screenshot** (a label, an error, a toast) → bare `iq "the text as shown"`, filled-in values and all. Text the workspace holds verbatim leads the answer; UI text in a translation catalog resolves to its key and answers with the component that renders it, so do not `rg` the key afterwards.
- **You have an address** (`/agents`, `/sandbox/agent?section=tools`) → `iq '/sandbox/agent?section=tools'`. It answers with the route declaration, the view it loads, and the branch each parameter and query value selects.
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
| do an answer's anchors hold? | `iq verify answer.md` (or pipe it in) |

Every answer opens with a capsule (`answer:`, `candidates:`, `more:`). Read that and stop — do not pipe through `head`; `--budget` already caps output. Lines under `answer:` say what it resolved through and what is next to it:

- `key: agents.agentActions.noConversationLeft · …/en.json:8 (+4 locales) · used at …/agentActions.ts:178` — the translation key UI text matched, and where code uses it.
- `route: /sandbox/:tab? at …/router/index.ts:375 loads …/SandboxHub.vue`, then one `tab=agent: …` line per value followed into the view.
- `siblings: pictureQuickLook.ts · ChatImageThumb.test.ts · …` — the other source files in the answer's folder, the ones iq ranked first. iq usually lands in the right folder; when the answer is a near miss, pick the neighbour from here instead of searching again. Scope with `--in`, `--repo`, `--lang`, `--glob`. Wrong grep habits (`iq search`, `iq ask`) are rewritten to `q`; use canonical forms next time. Full verb list: `iq --help`.

A question's `answer:` line ends with a verdict:

- `confident` — the top result scored as an answer on its own and clearly ahead of the rest, or is an exact match (one translation key, one route, one definition). Read it and stop.
- `ambiguous` — the most common word: nothing stood out enough to be sure. The answer is usually among the top files, their `siblings:` and the `candidates:`; compare those rather than searching again.
- `weak` — no result scored as a likely answer, so what you asked about probably does not exist in this workspace. Stop and say so, or rephrase once in the code's own words (the name you would expect it to have). A second `weak` means it is not here. Do not read on through the candidates or fall back to grep hunting for it.

**Session recall:** `iq sessions grab "topic"` for ranked excerpts from past sessions; `iq sessions files "topic"` for files those sessions touched. Verify load-bearing hits against current code.

**Another conversation**, rather than what past sessions touched, is the `agents` CLI: `agents show <handle>` answers one whole (its task, where it got to, branch, worktree, delta, record) from any spelling of its name — id, branch, id prefix, session id, or title words. `agents ls` is the fleet, `agents find '<text>'` is who said a phrase. Never search `/history` by hand for one.
