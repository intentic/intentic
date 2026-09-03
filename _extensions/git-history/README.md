# @intentic/ext-git-history

One repository's commit graph, its branches, and the actions you can take on them.

## Responsibilities

- Draw the history as a graph: commits, branches, merges, and where you are in it.
- Open a commit and show what it changed, as a file tree, and open any of those files' diffs beside the graph.
- Search commits, switch and group branches, manage stashes, undo the last operation.

## Key files

- [src/graphLayout.ts](src/graphLayout.ts): turning a commit list into a drawable graph; the hard part of this package.
- [src/groupBranches.ts](src/groupBranches.ts): how branches collapse into something readable at forty refs.
- [src/commitFileTree.ts](src/commitFileTree.ts): one commit's changes as a tree.
- [src/useGitLog.ts](src/useGitLog.ts): reading history from the daemon, paged.
- [src/useUndo.ts](src/useUndo.ts): what "undo" means for a git operation, and what it refuses to do.
- [src/extension.ts](src/extension.ts): activation, and the argument for a document rather than a view.

## How it fits

**A document, not a view.** A repository's history is read while looking at that repository's files, so it opens
as a tab in the Workspace's editor area rather than navigating away from them. That is the same argument the
documentation extension makes for its architecture pages, and the same grain: a path.

The graph is WIDE, which is why it earns the editor area rather than the sidebar. This is the division VSCode
makes between its SCM list and its Git Graph tab; the uncommitted half of the story: the Changes review:
stays in the app's sidebar where it already lives.

**The diff opens BESIDE the graph, not over it.** Clicking a file in a commit hands the host a diff, and because
this tab is a document with a file list in it, the host puts that diff in the editor's companion pane (its
`EditorStrip`) and leaves the graph where it is. Reading a commit is a list and a diff, and in one pane they take
turns: every file clicked used to replace the very list that named it. A click is a PEEK (one companion tab,
replaced by the next file) and a double-click keeps the tab, the grammar the Changes panel already uses; the row
whose diff is showing stays marked, so the two halves read as one view. The tab opens on the click with the
status letter and ± counts it already knows, and its content lands underneath (`pending` + `fillDiff`).

## Conventions & gotchas

- Every action goes through the daemon's git routes. Nothing here shells out, and nothing here holds a credential.
