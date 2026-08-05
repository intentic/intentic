# @intentic/ext-git-history

One repository's commit graph, its branches, and the actions you can take on them.

## Responsibilities

- Draw the history as a graph: commits, branches, merges, and where you are in it.
- Open a commit and show what it changed, as a file tree.
- Search commits, switch and group branches, manage stashes, undo the last operation.

## Key files

- [src/graphLayout.ts](src/graphLayout.ts) — turning a commit list into a drawable graph; the hard part of this package.
- [src/groupBranches.ts](src/groupBranches.ts) — how branches collapse into something readable at forty refs.
- [src/commitFileTree.ts](src/commitFileTree.ts) — one commit's changes as a tree.
- [src/useGitLog.ts](src/useGitLog.ts) — reading history from the daemon, paged.
- [src/useUndo.ts](src/useUndo.ts) — what "undo" means for a git operation, and what it refuses to do.
- [src/extension.ts](src/extension.ts) — activation, and the argument for a document rather than a view.

## How it fits

**A document, not a view.** A repository's history is read while looking at that repository's files, so it opens
as a tab in the Workspace's editor area rather than navigating away from them. That is the same argument the
documentation extension makes for its architecture pages, and the same grain — a path.

The graph is WIDE, which is why it earns the editor area rather than the sidebar. This is the division VSCode
makes between its SCM list and its Git Graph tab; the uncommitted half of the story — the Changes review —
stays in the app's sidebar where it already lives.

## Conventions & gotchas

- Every action goes through the daemon's git routes. Nothing here shells out, and nothing here holds a credential.
