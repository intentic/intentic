# `iq`: agent-native search CLI, surface API spec

Status: **surface design** (idealistic target). Engine/implementation choices come later; this spec is engine-agnostic.

`iq` (intentic query) is the single search tool an AI agent uses inside the sandbox instead of `grep`/`find`/`Glob` chains. One invocation returns a ranked, token-budgeted, answer-shaped result across lexical, structural, semantic, and git-history modalities, backed by an auto-managed incremental index.

## Design principles (the LLM-ergonomics contract)

1. **One entry point, intent-first.** The agent states *what it wants to know*, not *which engine to run*. Bare `iq "query"` auto-detects intent and fuses engines; verbs narrow when the agent knows exactly what it wants.
2. **Token budget is a first-class parameter.** Every invocation fits a declared output budget (default 1,500 tokens). The tool (not the agent) decides how to spend it: ranking, grouping, eliding. Truncation is always explicit and always comes with the exact follow-up command.
3. **Answer-shaped output.** Header (query, hit counts, index freshness) → ranked groups → footer (truncation + refinement hints). Never a raw unranked dump.
4. **Every result line is an actionable anchor.** `path:line`, compatible with the agent's Read tool. No post-processing needed.
5. **Zero ceremony.** No index commands in the happy path, the index self-builds and self-refreshes. Smart defaults everywhere: smart-case, .gitignore + secrets floor respected, binaries skipped.
6. **Deterministic & honest.** Same index state → same output. Grep-convention exit codes. Staleness disclosed, never hidden.
7. **Batch-friendly.** Multiple queries per process spawn (`iq multi`): round-trips are the agent's scarcest resource after tokens.

## Entry point: auto mode (the 90% path)

```
iq "<query>" [scope flags] [output flags]
```

Query auto-classification:

| Query shape | Engines fused |
|---|---|
| identifier (`camelCase`, `snake_case`, `Qualified.Name`) | symbol + lexical word-match |
| compiles as regex with metachars | regex lexical |
| contains `/` or glob chars, path-shaped | filename + content |
| natural language (spaces, question words) | semantic + keyword-expanded lexical |

Fusion is reciprocal-rank blending. Fused results tag each hit with *why* it matched: `[def]`, `[text]`, `[bm25 0.42]`, `[sem 0.87]`, `[rerank 0.93]`, `[path]`, `[import]`, `[call]`.

```
$ iq "where do we enforce the secrets floor during search?"
iq: ask (auto) — 6 hits in 3 files · index fresh (0.8s) · showing 6/6
════ src/workspace/workspace-ignore.ts ════
  41: export const isDeniedWorkspacePath = (path: string) =>        [sem 0.91] [def]
  57:   // layer 1: always-on security floor — secrets, .git, …    [sem 0.88]
════ src/workspace/workspace-search.ts ════
  23:   const scope = createIgnoreScope(root);                      [sem 0.79] [call]
hint: definition cluster in workspace-ignore.ts — `iq outline src/workspace/workspace-ignore.ts`
```

## Verbs: explicit narrowing

Every verb is also reachable as `iq --mode <verb>` for flat-flag harnesses.

### `iq find "<regex>"`: lexical content search

Regex by default; `--literal`, `--word`, `--case` (smart-case is the default: lowercase query → case-insensitive).

```
$ iq find 'createSdkMcpServer\(' --lang ts
iq: find — 3 matches in 2 files · showing 3/3
════ src/sessions/sessions.ts ════
  18: const server = createSdkMcpServer({
════ src/capabilities/mcp-tools.ts ════
  44:   createSdkMcpServer({ name, tools }),
  71:   // wraps createSdkMcpServer for capability wiring
```

### `iq files <pattern>`: filename search

Fuzzy by default (`wksearch` matches `workspace-search.ts`); `--exact` treats the pattern as a glob (`--glob` stays the shared scope filter).

```
$ iq files wkignore
iq: files — 2 hits · showing 2/2
  src/workspace/workspace-ignore.ts          [fuzzy 0.94]
  src/workspace/workspace-ignore.test.ts     [fuzzy 0.90]
```

### `iq def <symbol>`: where is X defined

Tree-sitter-backed; heuristic fallback for unindexed languages.

```
$ iq def createIgnoreScope
iq: def — 1 definition · showing 1/1
════ src/workspace/workspace-ignore.ts ════
  63: export const createIgnoreScope = (root: string): IgnoreScope => {
     signature: (root: string) => IgnoreScope
     refs: 23 in 6 files — `iq refs createIgnoreScope`
```

### `iq refs <symbol>`: who uses/calls X

`--kind call|import|type|write` narrows the reference kind.

```
$ iq refs createIgnoreScope --kind call
iq: refs createIgnoreScope --kind call — 18 refs in 5 files · showing 12/18
answer: src/workspace/workspace-tree.ts:48 · walkTree (fn) · [call]
candidates: src/workspace/search.ts:212 · src/agent/context.ts:77
more: 6 refs in 2 files — iq refs createIgnoreScope --kind call --after h3x1
════ src/workspace/workspace-tree.ts (4) ════
  48:   const scope = createIgnoreScope(root);
     … 3 more — iq context src/workspace/workspace-tree.ts:48
```

### `iq sym <pattern>`: fuzzy symbol-name search

`--kind fn|class|type|const|route|test`.

```
$ iq sym 'Workspace*Schema' --kind type
iq: sym — 4 symbols · showing 4/4
  WorkspaceSearchQuerySchema   const   _sandbox/sandbox-contract/src/schemas.ts:215
  WorkspaceSearchMatchSchema   const   _sandbox/sandbox-contract/src/schemas.ts:219
  WorkspaceSearchFileSchema    const   _sandbox/sandbox-contract/src/schemas.ts:223
  WorkspaceSearchSchema        const   _sandbox/sandbox-contract/src/schemas.ts:226
```

### `iq ast '<pattern>'`: structural AST pattern

ast-grep-style metavariables: `$X` one node, `$$$` any nodes. `--lang` is required (the pattern's parse language).

```
$ iq ast 'await $FN($$$).catch($$$)' --lang ts
iq: ast — 2 matches in 2 files · showing 2/2
════ src/agent/agent.ts ════
  132:   await query(prompt).catch(handleAbort)
════ src/codex/codex-agent.ts ════
  98:    await run(turn).catch(() => undefined)
```

### `iq "<question>"`: semantic / natural-language search

There is no separate verb: a bare query whose words are not an identifier, path or regex runs the full
hybrid-retrieval pipeline, and an exact query that matches nothing escalates into it. **BM25** (SQLite FTS5 over
the indexed chunks, rarity-weighted sparse ranking, tag `[bm25 0.42]`) fused with **embeddings** (dense), then a
**cross-encoder rerank** of the top fused hits (tag `[rerank 0.93]`, noted in the header). Without the baked
models it degrades to BM25-only: and says so in the header.

The response opens with the capsule, then the top hits' full enclosing bodies as live file lines:

```
$ iq "how does the daemon expose tools to Claude agents?"
iq: "how does the daemon expose tools…" — 8 hits in 4 files · index fresh (2.1s) · reranked · showing 5/8
answer: src/workspace/tools.ts:12 · agentToolSchema (const) · confident · [sem 0.90] [rerank 0.93]
candidates: src/agent/agent.ts:341 · src/mcp/registry.ts:19
more: 3 hits in 2 files — iq "how does the daemon expose tools…" --after p2m9
════ src/workspace/tools.ts ════
  12: export const agentToolSchema = z.object({                     [sem 0.90]
  38: export const mcpServersOf = (tools: AgentTool[]) =>           [sem 0.89]
```

### `iq outline <path>`: file skeleton

Signatures + first doc line only. Read a file's structure without spending its full token cost.

```
$ iq outline src/workspace/workspace-ignore.ts
iq: outline — src/workspace/workspace-ignore.ts (312 lines → 14 entries)
   9: const IGNORED_DIRS: Set<string>            // conservative junk denylist
  27: export const isSecretFile = (name) =>       // layer-1 security floor
  41: export const isDeniedWorkspacePath = (path) =>
  63: export const createIgnoreScope = (root): IgnoreScope =>
  64:   .descend(dir): IgnoreScope
  71:   .isIgnored(path): boolean
  90: export const toRelPath = (root, abs) =>
```

### `iq context <path:line>`: expand around an anchor

Returns the enclosing function/class; `-C <n>` grows further. The "zoom in" verb after any hit.

```
$ iq context src/workspace/workspace-tree.ts:48
iq: context — walkTree() src/workspace/workspace-tree.ts:39-72
  39: const walkTree = (root: string): TreeNode => {
  …full enclosing function body…
  72: };
```

### `iq recent [<pattern>]`: recently changed files/hunks

git + mtime blend; `--since 2d`, `--author <a>`. With a pattern, only matching hunks.

```
$ iq recent --since 2d
iq: recent — 7 files changed in last 2d · showing 7/7
  src/sessions/sessions.ts   3h ago   +41 -8   (2 commits)
  src/workspace/workspace-search.ts     1d ago   +12 -3
```

### `iq log "<pattern>"`: search git history

Pickaxe (`-S` literal count-change; `--regex` for `-G`); `--path`, `--since`.

```
$ iq log "MAX_TOTAL_MATCHES" --path src/workspace
iq: log — 2 commits touch "MAX_TOTAL_MATCHES" · showing 2/2
  a3f92c1  2026-06-30  radarsu  raise search budget to 200 matches
  01be774  2026-05-12  radarsu  add pure-node workspace search
```

### `iq who <path:line[-line]>`: blame an anchor

```
$ iq who src/workspace/workspace-search.ts:15
iq: who — src/workspace/workspace-search.ts:15
  a3f92c1  2026-06-30  radarsu  raise search budget to 200 matches
  line: const MAX_TOTAL_MATCHES = 200;
```

### `iq multi`: batch queries, one spawn

One query per stdin line: `<verb> <args>` or a bare auto-mode query. Output is one section per query; the `--budget` splits equally across sections (min 150 tokens each).

```
$ iq multi --budget 3000 <<'EOF'
def createIgnoreScope
refs isSecretFile --kind call
ask "where are watch events debounced?"
EOF
iq: multi — 3 queries · budget 3000 shared
[1/3] def createIgnoreScope …
[2/3] refs isSecretFile …
[3/3] ask "where are watch events debounced?" …
```

## Scope flags (all verbs)

```
--in <path>...          restrict to subtree(s); repeatable
--repo <name>           restrict to one repo in the multi-repo workspace
--lang ts,py            language filter (drives parser + extensions)
--glob '<g>'            include path glob; repeatable
--not-glob '<g>'        exclude path glob; repeatable
--only tests|src|docs|config    curated file-class shortcuts
--ignored               include .gitignore'd files (secrets floor NEVER lifted)
```

## Output flags (all verbs)

```
--budget <n>            max output tokens (default 1500); the tool allocates it
--limit <n>             cap result groups (files)
-C <n>                  context lines (default: smart — enclosing statement)
--files-only            ranked paths + match counts only
--count                 counts only
--full                  disable elision inside shown snippets
--json | --ndjson       structured output (mirrors sandbox-contract schemas)
--after <cursor>        resume a truncated result exactly where it stopped
```

## Text output rules

- **Header always states:** verb/mode, total vs shown, index freshness (`index fresh (1.2s)`, `index: building 62%, results from live scan`, or `[stale]` per file).
- **Groups ranked by relevance**, never path order.
- **Match-reason tags** on every line in auto/fused modes.
- **Footer gives the literal command** to continue (`--after <cursor>`) or refine.
- **`hint:` line** appears only when the hit distribution suggests an obvious narrowing (e.g. "18/23 refs are [call]; narrow with --kind call").

## Retrieval pipeline & feature toggles

Hybrid retrieval: ripgrep (exact), FTS5 **BM25** (ranked sparse) + **RM3 pseudo-relevance feedback** expansion,
dense **embeddings**, RRF fusion with the **defboost** / **pathboost** / **recency** multipliers (pathboost fires
when a path WORD starts with a query word: `indexer.ts` answers "index", `_textwrap.py` does not answer "wrap")
and a **srcfirst** class prior (implementation
ranks above its tests and docs, natural-language answers only), **cross-encoder rerank** that votes rather than
vetoes, and **confidence** stated on the answer line (`confident` / `ambiguous`). Hits carry their enclosing
symbol (**symctx**, `⟨in createWidget (fn)⟩`); natural-language answers append **graph** neighbors (`related:`
definition anchors, each with its strongest caller resolved) and **pack** the top groups as live code: source
groups only, because a packed test body spends the budget that would have shown the ranked files under it.
For hard questions the AGENT is the query rewriter: 2–3 phrasings through one `iq multi` spawn (HyDE inverted).

Every stage toggles for benchmarking via `--features` / `IQ_FEATURES`:
`bm25, semantic, rerank, prf, confidence, symctx, graph, defboost, pathboost, recency, srcfirst, pack`: `--features bm25` = only BM25;
`--features -rerank,-prf` = everything except those. The disabled set is echoed in the header
(`features -rerank`) and recorded in `--json` as `features` for run provenance.

## Agent contract (guarantees)

- **Exit codes:** `0` hits, `1` zero hits, `2` usage/error: scriptable in Bash chains.
- **Security floor:** secret files, `.git` internals, and denied subtrees are unreachable in *every* mode, including `--ignored`, `iq log`, and `iq who`. Reuses the layered model in `src/workspace/workspace-ignore.ts` (always-on floor → junk denylist → accumulated `.gitignore`).
- **Anchors are live:** every `path:line` refers to on-disk state. If the index is stale for a shown file, hits are re-verified against disk before printing or flagged `[stale]`.
- **Budget is hard:** output never exceeds `--budget`; truncation is always marked and always resumable via `--after`.
- **Deterministic:** same index state + same query → byte-identical output.
- **`iq --help` is agent-facing:** ≤400 tokens, examples-first, written in the register of an MCP tool description.

## Index lifecycle (invisible by default)

- First invocation (or sandbox boot hook) builds: trigram/lexical index, tree-sitter symbol tables, chunk embeddings, git metadata cache. Progress on stderr; live-scan results served meanwhile.
- A filesystem watcher (same mechanism as `src/workspace/workspace-watch.ts`) keeps it incremental; freshness appears in every header.
- Ops escape hatch only: `iq index status|rebuild|drop`.
- Semantic tier degrades gracefully to keyword-expanded lexical when no embedding backend exists.

## Intentic integration

1. **Package:** `@intentic/iq` (new `_apps/` or `_tools/` package), CLI on `@stricli/core`; `--json/--ndjson` honor `INTENTIC_OUTPUT` with secret masking.
2. **Reuse:** `createIgnoreScope`/`isDeniedWorkspacePath` from `workspace-ignore.ts`; extend `WorkspaceSearch*` zod schemas in `@intentic/sandbox-contract` for JSON output; retire `workspace-search.ts`: the daemon shells into `iq --json`.
3. **Agent exposure:** the binary is on the sandbox image `PATH`, called via Bash (all agent backends inherit it); the agent is taught to prefer it by the baked iq Claude Code plugin (`_search/iq/plugin` → `IQ_PLUGIN_DIR`, prepended to the SDK `plugins` option), whose skill + SessionStart nudge are the single source shared with the benchmark and external users. No in-process MCP tool in v1: it would duplicate the Bash path and cost tool-list tokens every turn; revisit if agents keep reaching for grep.
4. **Engine candidates (later):** ripgrep (lexical), tree-sitter/ast-grep (structural), tantivy/zoekt-style trigram index, local or API embeddings, `git log -S/-G` (history).

## Ergonomics dry-run (validation)

Five realistic agent tasks, each answerable in ≤2 invocations:

| Task | Invocations |
|---|---|
| "Where is the ignore model enforced in search?" | `iq "where is the ignore model enforced in search?"` → 1 |
| "Who calls createIgnoreScope?" | `iq refs createIgnoreScope --kind call` → 1 |
| "What's the shape of the search wire contract?" | `iq sym 'WorkspaceSearch*'` → `iq context <hit>` → 2 |
| "What changed around search recently?" | `iq recent search --since 7d` → 1 |
| "Find every awaited call with an inline .catch" | `iq ast 'await $FN($$$).catch($$$)' --lang ts` → 1 |

## Test plan (once implementation starts)

- Golden-file tests for text output shape per verb.
- Property test: output token count ≤ `--budget` for randomized queries/budgets.
- Secrets-floor test: no verb, flag, or cursor can surface a denied path (including via `iq log` history and `--ignored`).
- Determinism test: repeated query on frozen index → byte-identical output.
