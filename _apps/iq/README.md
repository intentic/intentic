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
- **Semantic search is optional.** `iq ask` uses a local embedding + cross-encoder model. Set `IQ_MODEL_DIR` to a directory holding them (fetch once with the bundled `node_modules/@intentic/iq-engine/scripts/fetch-model.mjs <dir>`). Without it, `ask` degrades to keyword-expanded lexical search — everything else works unchanged.

The index self-manages: it builds on first query and revalidates against disk on every run. Nothing to set up.

## Quickstart — pick the verb by what you already know

- **You know the file** (a stack trace or failing test names it) → open it directly; `iq context path:line` / `iq who path:line` for the surroundings. Searching is overhead here.
- **You know the exact identifier** → `iq def X` / `iq refs X` — one call replaces a grep-then-filter chain.
- **You don't know where it lives**, or your words may not match the code's vocabulary → bare `iq "…"` or `iq ask "…"`. This is where `iq` decisively beats grep.
- **You have error-message text** → `iq find 'literal text'`, then `iq context` on the hit.

| I want… | Run |
|---|---|
| text/regex match | `iq find 'createServer\(' --lang ts` |
| a file by name | `iq files wkignore` (`--exact` for globs) |
| where X is defined | `iq def createIgnoreScope` |
| who uses X | `iq refs createIgnoreScope --kind call` |
| symbols by pattern | `iq sym 'Workspace*Schema' --kind type` |
| structural AST pattern | `iq ast 'await $FN($$$)' --lang ts` |
| a natural-language answer | `iq ask "how does the daemon expose tools?"` |
| a file's skeleton | `iq outline src/workspace/workspace-ignore.ts` |
| code around a hit | `iq context src/workspace/workspace-tree.ts:48` |
| recent changes | `iq recent --since 2d` |
| history of a string | `iq log "MAX_TOTAL_MATCHES" --path src/workspace` |
| blame a line | `iq who src/file.ts:15` |
| several queries, one spawn | `iq multi <<'EOF'` … one per line … `EOF` |

Regex is **rust syntax**: alternation is `a|b` (not `a\|b`); for literal text use `--literal`.

## Output contract

- **Token budget is first-class.** Output fits `--budget` (default 1500 tokens); the tool decides how to spend it and truncates from the tail. Truncation footers print the exact `--after <cursor>` command to continue.
- **Every hit is a `path:line` anchor**; hits show their enclosing symbol (`⟨in createWidget (fn)⟩`), and `ask` appends `related:` definition anchors for follow-up.
- **Scope** with `--in <dir>`, `--repo <name>`, `--lang ts,py`, `--glob`/`--not-glob`, `--only tests|src|docs|config`; `--ignored` includes gitignored files (the security floor — secrets, `.git` — never lifts).
- **Exit codes** follow grep convention: `0` hits, `1` none, `2` usage error.
- **Machine output**: `--json` (one result document) or `--ndjson` (one line per group).
- **Zero hits are never a dead end** — the footer diagnoses the likely cause (grep-style regex, over-narrow scope, exact-name miss) and suggests the next command.

## Configuration (environment)

| Var | Effect |
|---|---|
| `WORKSPACE_ROOT` | Directory to search (default: current directory). |
| `IQ_MODEL_DIR` | Embedding/reranker model directory; unset → `ask` degrades to lexical. |
| `IQ_RG_PATH` | Override the ripgrep binary resolved from `PATH`. |
| `INTENTIC_OUTPUT` | Default output mode when no flag is given: `text` (default), `json`, `ndjson`. |
| `IQ_FEATURES` | Retrieval-stage toggles (see below); the `--features` flag overrides it. |
| `IQ_DEBUG` | Keep the full JS stack on a thrown error instead of the one-line message. |

## How it works

A bare query is classified (identifier / regex / path / natural-language) and routed through a fused pipeline:

**ripgrep** (exact) + **FTS5 BM25** (sparse relevance) + **RM3 pseudo-relevance feedback** (query expansion) + **dense embeddings** (semantic) → **reciprocal-rank fusion** with def/path/recency boosts → **cross-encoder rerank** (blended into the fused order via RRF — it *votes*, it doesn't veto) → **enclosing-symbol context** + **graph** neighbor anchors + **pack** (the top groups arrive as the actual code slice, not just a pointer, so the reader usually needs no follow-up open).

All nine stages are independently toggleable for benchmarking and deployment tuning, via `--features` or `IQ_FEATURES` (allow-list `bm25` = only BM25; default-minus `-rerank,-prf` = all except those):

`bm25`, `semantic`, `rerank`, `prf`, `confidence`, `symctx`, `graph`, `boosts`, `pack`.

Structural search (`ast`) uses ast-grep; history verbs (`log`, `who`, `recent`) use git.

## Benchmarks

`iq` is measured by a two-tier harness in [`_tools/iq-bench`](../../_tools/iq-bench) — tier 1 scores retrieval quality against golden query→anchor datasets with no LLM (free, deterministic); tier 2 runs real coding-agent CLIs on real tasks, paired with and without `iq`, graded automatically (answer must name the ground-truth `path:line`, or the repo's tests must pass). All numbers below are reproducible by re-running the committed harness and datasets.

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

On trivial single-file lookups `iq` is roughly break-even (when the answer is one obvious grep away, the index fetch is overhead it can't earn back) — the value is concentrated where retrieval is genuinely hard. Full methodology, per-task tables, paired statistics, and transcripts: [`_tools/iq-bench`](../../_tools/iq-bench).

## Using it with a coding agent

`iq` ships as a **Claude Code plugin** ([`plugin/`](plugin)) that teaches an agent to prefer `iq` over grep/find/Glob by default — a bundled skill plus a SessionStart nudge. The plugin installs the *teaching*, not the binary, so install both:

```sh
npm i -g @intentic/iq                              # the CLI (also needs Node ≥ 24 + ripgrep, see Install)
/plugin marketplace add radarsu/intentic           # the marketplace (or the repo's https URL)
/plugin install iq                                  # the skill + nudge
```

The plugin's skill lives at [`plugin/skills/iq/SKILL.md`](plugin/skills/iq/SKILL.md) and doubles as a `CLAUDE.md` / `AGENTS.md` note if you'd rather paste it in directly. The Agent SDK loads the same plugin via `plugins: [{ type: "local", path: "…/_apps/iq/plugin" }]`. The intentic sandbox bakes this exact plugin into its image, so the sandbox agent and an external user get identical behavior.

## License

MIT
