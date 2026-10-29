# git-history

The Git tab of a repository's panel: its commit graph across every ref, with branch, tag, stash, merge, rebase and undo actions on it.

```mermaid
flowchart LR
    tree["Workspace tree<br/>repo row"] --> tab(["git-history<br/>Git tab"])
    palette["Command palette<br/>Show Git History"] --> tab
    tab -->|"GET /git/*/log · diffs"| daemon["Daemon git routes"]
    tab -->|"POST merge · rebase · undo"| daemon
    tab -->|"view · start from"| editor["Workspace view<br/>new agent"]
    daemon --> repo["Repository in /work"]
    daemon -->|"ref push"| tab
```

- Runs in the browser, compiled into the web bundle. Every git operation is a daemon route listed in the manifest's `permissions.sandbox`; the extension never touches the repository itself.
- Registered as an auxiliary `directory` view, so every repository gets the tab without starving views that serve only unclaimed ones. The workspace root has no tree row, so a `documents` entry and the `git-history.open` command open its history instead.
- Clicking a file in a commit opens its diff in the editor's companion pane, from a repository panel and the root's document alike, so the graph stays on screen. A click peeks and a double-click keeps the tab.
- Uncommitted work draws as an ordinary row parented to `HEAD`, and stashes splice in above the commit they were taken on, so the lane layout handles both without special cases.
- The shared workspace stays on each repository's main line, so nothing here switches it. A branch's row in the header's list, and its pill in the graph, offer View in Workspace (the Workspace's per-person view of that branch) and Start agent from (a new chat whose private copy is cut from it); a remote-only branch goes by its short name. A new branch is created where the workspace stands, without switching to it.
- Undo walks the branch back over its last move and leaves already-fixed files alone; Checkpoints restore the working tree instead. A halted merge or rebase left by a terminal shows with a way out.
- History loads page by page as the graph scrolls; search covers only loaded pages.

## Key files

- [src/extension.ts](src/extension.ts) — the per-repository view, the root document and the palette command.
- [src/GitHistoryTab.vue](src/GitHistoryTab.vue) — the graph, inline commit detail, diffs and the context menu.
- [src/graphLayout.ts](src/graphLayout.ts) — pure lane and colour geometry for the graph.
- [src/useGitLog.ts](src/useGitLog.ts) — the paged log query and lazy per-commit detail.
- [src/branchActions.ts](src/branchActions.ts) — a branch's two actions, view in the Workspace and start an agent from it.
- [src/useUndo.ts](src/useUndo.ts) — the last branch-moving action and its reversal.

## Commands

```sh
pnpm --filter @intentic/ext-git-history test
```
