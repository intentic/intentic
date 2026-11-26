# text-search

The searches behind the editor's search box: text in files and file names, each one a ripgrep walk of the tree as it is on disk, with no index to build or keep.

```mermaid
flowchart LR
    box["Search box<br/>quick-open · @-mentions"] --> daemon["Sandbox daemon<br/>workspace.search"]
    daemon -- "find" --> text(["findText<br/>rg --json"])
    daemon -- "files" --> files(["findFiles<br/>rg --files + fuzzy rank"])
    text --> floor["floor<br/>.intentic allow-list"]
    files --> floor
```

- `findText` runs one `rg --json` over the scope and hands each file over as soon as its lines are in, which is what the daemon streams. It stops at `TEXT_MAX_HITS` lines (the file it is in finished first) and keeps at most 50 lines a file, long lines cut to a window around their first match.
  - A pattern rg cannot read runs again as plain text, and grep-style escapes (`a\|b`) are rewritten to rust regex when the pattern as written matches nothing. The answer's note says which happened.
- `findFiles` lists the tree with `rg --files` and ranks the paths against the query with `@intentic/base/fuzzy`. A query holding a glob character (`*`, `?`, `[`) is matched as a glob instead. The editor asks the daemon for it only when its own copy of the tree cannot answer: ignored files included, or a tree too large to send.
- Both walks admit what the workspace tree admits: every `.gitignore` at or below the root, whether or not it is a repository; nothing from the global excludes, `.git/info/exclude` or `.ignore` files; the junk folders, the reference shelf and agent worktrees pruned (`@intentic/workspace-ignore`); dotfiles in. `ignored` walks into what a `.gitignore` names.
- The floor (`src/floor.ts`) is the gate on what comes back, whatever the walk let through, and `ignored` never lifts it: inside any `.intentic` directory only the authored, versioned slice (`SEARCHABLE_STATE_PATHS` in the sandbox contract) is searchable.
- A search that found nothing can be probed (`src/probes.ts`): run again with one switch changed (any case, ignored and hidden files in, the pattern as plain text, each only where it could differ), count-only and side by side, killed together after 1.5 s, and each probe that matched says how many files and the first three. `probeRgSearch` reads the search as rg on a command line does (an agent's Grep tool, through the daemon's PostToolUse hook); `probeFound` as the box does, over its own walk and floor, and the daemon puts what it finds in an empty answer's `note`. The ignored probe still prunes version control, dependency trees, caches, Rust's `target`, the reference shelf and the workspace's machine state: walking node_modules took it 5 s on this monorepo, against 30 to 290 ms without (2026-11-26). output-cleaners keeps a builtins-only copy for shell `rg` and `grep -r`, held to this one by its tests.
- These searches run in the daemon's own process, at its own priority. They lived in the iq engine until iq was removed (2026-11-18); its resident child had made a search wait 10 to 20 s on a loaded machine (2026-10-26) where ripgrep alone took 20 to 100 ms.

## Key files

- [src/text-search.ts](src/text-search.ts) — `findText` and `scanText`: the walk, the per-file cap, the ceiling and the pattern recoveries.
- [src/file-search.ts](src/file-search.ts) — `findFiles`: the file listing and its ranking.
- [src/floor.ts](src/floor.ts) — what no search can ever surface.
- [src/glob.ts](src/glob.ts) — how a files-to-include pattern is read, as ripgrep's `-g` reads it.
- [src/probes.ts](src/probes.ts) — what a search that found nothing would have found with one switch changed.

## Commands

```sh
pnpm --filter @intentic/text-search test
```
