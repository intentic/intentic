# iq

**Agent-native workspace search — one intent-first CLI over lexical, structural, semantic, and git engines.**

`iq` replaces the `grep`/`find`/`Glob` chains a coding agent (or you) would otherwise run. One call returns ranked, token-budgeted, answer-shaped results where every line is a `path:line` anchor you can open directly. It auto-detects intent, fuses several search engines, and fits the answer to a token budget so it drops cleanly into an LLM's context.

```
iq "where do we enforce the secrets floor?"
```

## Install

```sh
npm i -g @intentic/iq      # or: pnpm add -g @intentic/iq
```

**Requirements**

- **Node ≥ 24** (uses `node:sqlite`).
- **ripgrep** on `PATH` — the lexical engine shells into `rg`. Install via your package manager (`apt install ripgrep`, `brew install ripgrep`, …) or point `IQ_RG_PATH` at a binary.
- **Semantic search is optional.** Natural-language queries use a local embedding + cross-encoder model. Set `IQ_MODEL_DIR` to a directory holding them (fetch once with the bundled `node_modules/@intentic/iq-engine/scripts/fetch-model.mjs <dir>`). Without it, they degrade to keyword-expanded lexical search — everything else works unchanged.

The index self-manages: it builds on first query and revalidates against disk on every run. Nothing to set up.

## Quickstart — pick the verb by what you already know

- **You know the file** (a stack trace or failing test names it) → open it directly; `iq context path:line` / `iq who path:line` for the surroundings. Searching is overhead here.
- **You know the exact identifier** → `iq def X` / `iq refs X` — one call replaces a grep-then-filter chain.
- **You don't know where it lives**, or your words may not match the code's vocabulary → bare `iq "…"`, phrased as a question. Natural language has no verb of its own. This is where `iq` decisively beats grep.
- **You have error-message text** → `iq find 'literal text'`, then `iq context` on the hit.
- **You know nothing yet** — a repo you've never opened → `iq map --budget 4000` for the shape, `iq hotspots` for where the risk sits. These answer "what is this and where do I start", which no amount of searching does.

| I want… | Run |
|---|---|
| the repo's shape | `iq map --budget 4000` |
| where risk concentrates | `iq hotspots --in _apps` |
| what my change reaches | `iq impact` |
| text/regex match | `iq find 'createServer\(' --lang ts` |
| a file by name | `iq files wkignore` (`--exact` for globs) |
| where X is defined | `iq def createIgnoreScope` |
| who uses X | `iq refs createIgnoreScope --kind call` |
| symbols by pattern | `iq sym 'Workspace*Schema' --kind type` |
| structural AST pattern | `iq ast 'await $FN($$$)' --lang ts` |
| a natural-language answer | `iq "how does the daemon expose tools?"` |
| a file's skeleton | `iq outline src/workspace/workspace-ignore.ts` |
| code around a hit | `iq context src/workspace/workspace-tree.ts:48` |
| recent changes | `iq recent --since 2d` |
| history of a string | `iq log "MAX_TOTAL_MATCHES" --path src/workspace` |
| blame a line | `iq who src/file.ts:15` |
| several queries, one spawn | `iq multi "how is auth refreshed" "def refreshToken"` |

Regex is **rust syntax**: alternation is `a|b` (not `a\|b`); for literal text use `--literal`.

## Output contract

- **Answer first.** Every response opens with a capsule that precedes the code: `answer:` names the top anchor, its enclosing symbol and whether the top result is `confident` or `ambiguous`; `candidates:` names the ranked `path:line` anchors that did not fit; `more:` gives the exact `--after <cursor>` command. A reader that keeps only the first few lines keeps everything actionable.
- **Token budget is first-class.** Output fits `--budget` (default 1500 tokens); the tool decides how to spend it and truncates whole groups from the tail.
- **Every hit is a `path:line` anchor** into the live file; hits show their enclosing symbol (`⟨in createWidget (fn)⟩`), and natural-language answers deliver the top hits' full enclosing bodies plus `related:` definition anchors for follow-up.
- **Scope** with `--in <dir>`, `--repo <name>`, `--lang ts,py`, `--glob`/`--not-glob`, `--only tests|src|docs|config`; `--ignored` includes gitignored files (the security floor — secrets, `.git` — never lifts).
- **Exit codes** follow grep convention: `0` hits, `1` none, `2` usage error.
- **Machine output**: `--json` (one result document) or `--ndjson` (one line per group).
- **Zero hits are never a dead end** — an identifier, path or pattern that matches nothing exactly is re-run semantically (the header says so), and a genuine zero carries a `hint:` diagnosing the likely cause.

## Configuration (environment)

| Var | Effect |
|---|---|
| `WORKSPACE_ROOT` | Directory to search (default: current directory). |
| `IQ_MODEL_DIR` | Embedding/reranker model directory; unset → natural-language queries degrade to lexical. |
| `IQ_RG_PATH` | Override the ripgrep binary resolved from `PATH`. |
| `INTENTIC_OUTPUT` | Default output mode when no flag is given: `text` (default), `json`, `ndjson`. |
| `IQ_FEATURES` | Retrieval-stage toggles (see below); the `--features` flag overrides it. |
| `IQ_DEBUG` | Keep the full JS stack on a thrown error instead of the one-line message. |

## How it works

A bare query is classified (identifier / regex / path / natural-language) and routed through a fused pipeline:

**ripgrep** (exact) + **FTS5 BM25** (sparse relevance) + **RM3 pseudo-relevance feedback** (query expansion) + **dense embeddings** (semantic) → **reciprocal-rank fusion** with **defboost** / **pathboost** / **recency** multipliers (one toggle each; pathboost matches path *words*, so `indexer.ts` answers "index" while `_textwrap.py` does not answer "wrap") and a **source-first** class prior (implementation over its tests and docs, natural-language answers only) → **cross-encoder rerank** (blended into the fused order via RRF — it *votes*, it doesn't veto) → **enclosing-symbol context** + **graph** neighbor anchors + **pack** (the top groups arrive as the actual code slice, not just a pointer, so the reader usually needs no follow-up open).

All twelve stages are independently toggleable for benchmarking and deployment tuning, via `--features` or `IQ_FEATURES` (allow-list `bm25` = only BM25; default-minus `-rerank,-prf` = all except those):

`bm25`, `semantic`, `rerank`, `prf`, `confidence`, `symctx`, `graph`, `defboost`, `pathboost`, `recency`, `srcfirst`, `pack`.

Structural search (`ast`) uses ast-grep; history verbs (`log`, `who`, `recent`) use git.

### Orientation verbs

`map` ranks files by **PageRank over the import graph** — an edge A→B means A imports B — then prints each file's exported signatures until `--budget` runs out. Specifiers are extracted at index time and resolved at query time against the indexed file set: relative paths directly (including TypeScript's `./x.js` → `x.ts` rule), bare specifiers via each workspace `package.json`'s `name`, so cross-package imports don't fragment a monorepo into disconnected islands. Unresolved specifiers — node_modules, stdlib — are simply not edges. Generated files contribute no definitions; a re-export shim would otherwise look like the most depended-upon file in the repo.

An earlier version built edges from exported-symbol name matches instead. It doesn't work at any weighting: text can't tell a reference from a coincidence, so modules exporting ordinary words (`App`, `Host`, `Repo`) top the list.

`hotspots` multiplies **git churn** (commits touching a file) by **complexity** (branch points, counted at index time from the same ast-grep parse that extracts symbols, with a lexical fallback for languages that have no grammar). Neither half is interesting alone: a churning config file is trivial, a gnarly file nobody edits costs nobody anything. Data and markup score zero — keyword scans there read content, not code paths.

Complexity is reported as a **raw branch count**, not a composite score: counts are comparable to the file in front of you, and you can recount them by hand.

`impact` answers "what does this change reach?" over the same import graph. With no argument it reads your uncommitted changes; given paths, it answers about those. Each result carries its distance and whether it is a test, and the header names what the walk could **not** answer: seeds the index has never seen, how many reachable files the cap dropped, and — the useful half — which changed files no test reaches at all.

It walks exactly **one hop, in both directions**, and that is a measured choice rather than a cautious one. Against 762 co-change cases mined from this repo's own history (`iq-bench impact`), one hop each way beat the no-graph "same folder" baseline 444 wins to 168 and beat one hop of importers alone 318 to 159, both at p < 0.001. Depth made it worse, not better: two hops of importers *lost* to one hop, and two hops in both directions reach hundreds of files per seed at 0.06 precision. Coverage depth is deliberately separate and deliberately timid — a test that imports the file directly counts, nothing further — because the co-change benchmark measured which files change together, which is not the same question as which tests exercise what, and borrowing its answer would be borrowing evidence never collected.

## Benchmarks

`iq` is measured by a two-tier harness in [`_search/iq-bench`](../../_search/iq-bench) — tier 1 scores retrieval quality against golden query→anchor datasets with no LLM (free, deterministic); tier 2 runs real coding-agent CLIs on real tasks, paired with and without `iq`, graded automatically (answer must name the ground-truth `path:line`, or the repo's tests must pass). All numbers below are reproducible by re-running the committed harness and datasets.

### Tier 1 — retrieval quality (90 golden queries, 3 repos: this workspace + `hono` + `click`)

The full pipeline is the best configuration on aggregate (recall@5 **0.81**, recall@10 **0.88**, nDCG@10 **0.65**). Ablations, paired per query vs the full pipeline (exact sign test):

| Configuration | vs full | Δ recall@10 | Verdict |
|---|---|---:|---|
| drop **semantic** | loses 24 / wins 3 (p<0.001) | −0.04 | significant — dense retrieval earns its place |
| **lexical only** (grep-grade) | loses 27 / wins 3 (p<0.001) | −0.09 | significantly worse on natural-language queries |
| **bm25 only** | loses 29 / wins 7 (p<0.001) | −0.07 | significantly worse |
| drop **rerank** | loses 5 / wins 4 (p=1.0) | ±0.00 | neutral on ranking (helps agents downstream) |
| drop **pack** | loses 0 / wins 3 (p=0.25) | +0.02 | ranking-neutral (marginally trims recall); payoff is agent-side (below) |

The gap over grep-grade retrieval concentrates exactly on the synonym-gap queries where an agent's phrasing differs from the code's vocabulary — the case `iq` exists for.

### Tier 2 — does it help a real agent? (Claude Sonnet, 8 tasks, `iq` vs plain grep/find)

Both arms solved every task, so at this difficulty `iq` doesn't change *whether* the problem is solved — it changes the *cost* of getting there, and the gap widens with search difficulty:

- **Aggregate: iq $2.19 vs grep $3.29 across 8 tasks (−33% cost).**
- **The search-hardest task** (trace an off-by-2 bug through a URL parser): grep baseline burned **21 turns / $1.27 / 306 s**; with `iq`, **10 turns / $0.33 / 50 s** — **−74% cost, −52% turns, −84% wall.** The baseline thrashed through ad-hoc probes and repeated reads; `iq` located the mechanism directly.

On trivial single-file lookups `iq` is roughly break-even (when the answer is one obvious grep away, the index fetch is overhead it can't earn back) — the value is concentrated where retrieval is genuinely hard. Full methodology, per-task tables, paired statistics, and transcripts: [`_search/iq-bench`](../../_search/iq-bench).

## Using it with a coding agent

`iq` ships as a **Claude Code plugin** ([`plugin/`](plugin)) that teaches an agent to prefer `iq` over grep/find/Glob by default — a bundled skill plus a SessionStart nudge. The plugin installs the *teaching*, not the binary, so install both:

```sh
npm i -g @intentic/iq                              # the CLI (also needs Node ≥ 24 + ripgrep, see Install)
/plugin marketplace add intentic/intentic           # the marketplace (or the repo's https URL)
/plugin install iq                                  # the skill + nudge
```

The plugin's skill lives at [`plugin/skills/iq/SKILL.md`](plugin/skills/iq/SKILL.md) and doubles as a `CLAUDE.md` / `AGENTS.md` note if you'd rather paste it in directly. The Agent SDK loads the same plugin via `plugins: [{ type: "local", path: "…/_search/iq/plugin" }]`. The intentic sandbox bakes this exact plugin into its image, so the sandbox agent and an external user get identical behavior.

## License

MIT

## Key files

- [src/commands](src/commands) — one file per verb; the CLI surface an agent actually types.
- [src/app.ts](src/app.ts) — verb dispatch and intent detection for a bare query.
- [src/lib](src/lib) — rendering results inside a token budget.
- [src/cli.ts](src/cli.ts) — the entry point.
