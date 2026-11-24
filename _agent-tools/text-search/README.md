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
- These searches run in the daemon's own process, at its own priority. They lived in the iq engine until iq was removed (2026-11-18); its resident child had made a search wait 10 to 20 s on a loaded machine (2026-10-26) where ripgrep alone took 20 to 100 ms.

## Key files

- [src/text-search.ts](src/text-search.ts) — `findText` and `scanText`: the walk, the per-file cap, the ceiling and the pattern recoveries.
- [src/file-search.ts](src/file-search.ts) — `findFiles`: the file listing and its ranking.
- [src/floor.ts](src/floor.ts) — what no search can ever surface.
- [src/glob.ts](src/glob.ts) — how a files-to-include pattern is read, as ripgrep's `-g` reads it.

## Commands

```sh
pnpm --filter @intentic/text-search test
```
