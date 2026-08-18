# @intentic/iq-bench

Benchmark harness answering three questions about `iq`:

1. **Which retrieval pipeline configuration works best?** — tier 1, no LLM, ~$0.
2. **Does impact analysis predict what a change touches?** — tier 1b, no LLM, ~$0.
3. **Does iq make real coding agents more reliable and cheaper than grep/rg?** — tier 2, vendor CLIs, a few dollars.

## Tier 1 — retrieval quality

```sh
pnpm --filter @intentic/iq-bench bench:retrieval          # all repos × all configs
node dist/cli.js retrieval --repo hono --config no-rerank # filtered
```

- Golden datasets in `datasets/*.queries.json`: query → expected `path[:line]` anchors. Repos: the intentic monorepo itself plus external repos pinned in `datasets/repos.lock.json` (cloned shallow at the locked SHA into `.cache/repos/`).
- `def`/`sym` anchors name a file only — their line is resolved from the tree at scoring time (`src/anchors.ts`), so refactoring the corpus cannot silently turn a hit into a miss. Anchors for the judgement verbs (`q`, `find`, `refs`) carry the line the dataset author picked.
- Configs in `src/configs.ts`: `full`, one single-stage ablation per ranking- or budget-affecting stage (`-semantic`, `-rerank`, `-prf`, `-defboost`, `-pathboost`, `-recency`, `-symctx`, `-graph`, `-srcfirst`, `-pack`) so a delta attributes to exactly one stage, plus the `lexical` and `bm25-only` floors — swept in-process against one shared index per repo (features are query-time only).
- Metrics: recall@{1,5,10}, MRR@10, nDCG@10 over ranked file groups (+`related` and `candidates` anchors — everything the one response hands back openable), output tokens/query (iq's own estimator), p50 latency (includes the revalidation sweep — the honest CLI-equivalent number), index build time.
- Embedding models auto-fetch to `.cache/models` (~57 MB); if unavailable, semantic/rerank configs are **skipped**, never silently degraded.
- Deterministic on a frozen index: rerun ⇒ identical scores.

## Tier 1b — impact accuracy

```sh
pnpm --filter @intentic/iq-bench bench:impact       # the monorepo's own history
```

Only the monorepo works today: the lock file's external repos are fetched at `--depth 1` for tier 1, which leaves no history to mine. Pointing `--repo` at one is not silently empty — the report leads with a shallow-clone warning — but making them usable means a deeper fetch, which tier 1 does not need and nothing has paid for yet.

- **Ground truth is git, never the graph.** Show the predictor ONE file from a past commit; grade it on which *other* files that commit touched. The dataset is mined at run time from the last 400 commits — nothing to hand-curate, and nothing to keep in step with the corpus.
- This is the trap the idea came from. A well-known tool published recall of 1.0 for the same feature, measured against a set derived from the graph doing the predicting: circular by construction, and it cannot fail. Its one independent measurement returned zero.
- **Two baselines, both of which a strategy must beat**: `same-dir` consults no graph at all (co-change is strongly local, so folder siblings are a genuinely hard bar), and `importers-1` is the reach the `related:` line already gives us. Strategies sweep direction (`importers`, `imports`, `both`), depth, and the truncation cap.
- Metrics: precision/recall/F1 per case, plus the share of cases where the strategy predicted **nothing** — a silent empty answer reads as "nothing is affected" and is the failure mode that matters most here. Head-to-head is paired per case with an exact sign test.
- Commits are dropped, and counted in the report, when they touch fewer than two code files or when the current index does not know their files (renamed or deleted since). The graph describes the working tree; grading it against paths that no longer exist would measure drift, not accuracy.

**Reading it honestly:** co-change is a proxy. Authors batch unrelated edits into one commit, and a genuinely affected file that needed no edit scores as a false positive — both push measured precision down, so a strategy that wins here is not being flattered. Read recall as the signal and precision as a loose upper bound on noise.

## Tier 2 — end-to-end agent runs

```sh
node dist/cli.js agents --dry                                   # print the plan, spawn nothing
pnpm --filter @intentic/iq-bench bench:agents                   # full paired run (sets IQ_BENCH_AGENTS=1)
node dist/cli.js agents --task hono-etag-match --vendor claude --model claude-haiku-4-5   # smoke (needs IQ_BENCH_AGENTS=1)
```

- Tasks in `tasks/locate/*.json` (answer must name ground-truth `path:line` — graded by deterministic anchor matching, no LLM judge) and `tasks/fix/*.json` (bug patch applied, graded by running the repo's tests).
- Arms, paired within model:
  - `a` — baseline: fresh worktree + neutral notes file ("use grep/rg/find").
  - `b` — iq: same worktree + the iq skill as CLAUDE.md/AGENTS.md, `iq` shim on PATH, index pre-built (build time recorded separately, not charged to the agent).
  - `c:<config>` — arm b with `IQ_FEATURES` set, e.g. `--arms a,b,c:lexical`.
- Vendors: `claude` (Claude Code headless, default model `claude-opus-4-8`), `codex` (`codex exec`, uses your configured default model unless `--model`), `grok` (stub — fill in `src/agents/grok.ts` once its headless flags are verified). Unavailable vendors are skipped with a warning.
- Caps: per-task `maxTurns` (claude) + wall-clock timeout (all vendors, default 10 min) + `--max-spend <usd>` (default 40) that aborts the sweep on vendor-reported cost.
- Results: `results/<ts>/agents/runs.jsonl` + full transcripts + `summary.md` with per-task paired table, exact sign test, bootstrap CI (descriptive). Deltas are within-model only — cross-model absolute comparisons are intentionally not reported.

### Prerequisites

- `pnpm build` at the repo root (arm b shims `_search/iq/dist/cli.js`).
- Vendor CLIs authenticated in your shell (`claude`, `codex`); the run inherits your login.
- For hono fix tasks: `npm install` inside `.cache/repos/hono` once (worktrees symlink its `node_modules`).

### Reading the results honestly

- N is tiny by design (cost ceiling): the per-task table is the result; means are context. The report auto-flags N < 6 as directional.
- User-level agent config (`~/.claude` memory + hooks) is inherited by both arms — removing it would break CLI auth (`CLAUDE_CONFIG_DIR` holds credentials), so the pairing cancels it within a model instead. MCP servers and web/subagent tools ARE stripped (`--strict-mcp-config`, `--disallowedTools`).
- Intentic tasks are contamination-free (repo is brand-new); external tasks are pinned post-cutoff — the report keeps repos visible per row so the splits can be compared.

## Cost levers

In order of power: drop `fix` tasks (2–3× a locate run each) → reduce task count → lower `maxTurns` → `--model claude-haiku-4-5` for iteration → `--max-spend` as the hard backstop.

## Key files

- [src/retrieval.ts](src/retrieval.ts) — tier 1: does a query surface the right file.
- [src/agents](src/agents) — tier 2: whole agent runs against real repos.
- [src/score.ts](src/score.ts) — how a run becomes a number.
- [src/anchors.ts](src/anchors.ts) — the ground truth each query is graded against.
- [src/report.ts](src/report.ts) — the output a change is judged on.
