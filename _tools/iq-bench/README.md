# @intentic/iq-bench

Benchmark harness answering two questions about `iq`:

1. **Which retrieval pipeline configuration works best?** — tier 1, no LLM, ~$0.
2. **Does iq make real coding agents more reliable and cheaper than grep/rg?** — tier 2, vendor CLIs, a few dollars.

## Tier 1 — retrieval quality

```sh
pnpm --filter @intentic/iq-bench bench:retrieval          # all repos × all configs
node dist/cli.js retrieval --repo hono --config no-rerank # filtered
```

- Golden datasets in `datasets/*.queries.json`: query → expected `path[:line]` anchors. Repos: the intentic monorepo itself plus external repos pinned in `datasets/repos.lock.json` (cloned shallow at the locked SHA into `.cache/repos/`).
- Configs in `src/configs.ts`: `full`, one single-stage ablation per ranking- or budget-affecting stage (`-semantic`, `-rerank`, `-prf`, `-defboost`, `-pathboost`, `-recency`, `-symctx`, `-graph`, `-srcfirst`, `-pack`) so a delta attributes to exactly one stage, plus the `lexical` and `bm25-only` floors — swept in-process against one shared index per repo (features are query-time only).
- Metrics: recall@{1,5,10}, MRR@10, nDCG@10 over ranked file groups (+`related` and `candidates` anchors — everything the one response hands back openable), output tokens/query (iq's own estimator), p50 latency (includes the revalidation sweep — the honest CLI-equivalent number), index build time.
- Embedding models auto-fetch to `.cache/models` (~57 MB); if unavailable, semantic/rerank configs are **skipped**, never silently degraded.
- Deterministic on a frozen index: rerun ⇒ identical scores.

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

- `pnpm build` at the repo root (arm b shims `_apps/iq/dist/cli.js`).
- Vendor CLIs authenticated in your shell (`claude`, `codex`); the run inherits your login.
- For hono fix tasks: `npm install` inside `.cache/repos/hono` once (worktrees symlink its `node_modules`).

### Reading the results honestly

- N is tiny by design (cost ceiling): the per-task table is the result; means are context. The report auto-flags N < 6 as directional.
- User-level agent config (`~/.claude` memory + hooks) is inherited by both arms — removing it would break CLI auth (`CLAUDE_CONFIG_DIR` holds credentials), so the pairing cancels it within a model instead. MCP servers and web/subagent tools ARE stripped (`--strict-mcp-config`, `--disallowedTools`).
- Intentic tasks are contamination-free (repo is brand-new); external tasks are pinned post-cutoff — the report keeps repos visible per row so the splits can be compared.

## Cost levers

In order of power: drop `fix` tasks (2–3× a locate run each) → reduce task count → lower `maxTurns` → `--model claude-haiku-4-5` for iteration → `--max-spend` as the hard backstop.
