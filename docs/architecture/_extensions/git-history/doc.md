# @intentic/ext-git-history

One repository's commit graph, its branches, and the actions on them.

```stats
{
  "items": [
    {"label": "Lines", "value": "2.5k"},
    {"label": "Files", "value": "25"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Reviewing what an agent did means reading history, and history is wide: a graph of commits, the
branches over it, and a diff beside them. The app's own sidebar already carries the *uncommitted*
half — the Changes review — and this is the other half, in the space that can hold it.

```dag
{ "title": "Its neighbours", "direction": "LR",
  "nodes": [
    {"id": "_extensions/git-history", "label": "git-history", "note": "this package", "accent": "3"},
    {"id": "_libs/extension-api", "label": "extension-api", "note": "it uses", "accent": "3"},
    {"id": "_libs/extension-ui", "label": "extension-ui", "note": "it uses", "accent": "3"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/web", "label": "web", "note": "uses it", "accent": "1"}
  ],
  "edges": [
    {"from": "_extensions/git-history", "to": "_libs/extension-api"},
    {"from": "_extensions/git-history", "to": "_libs/extension-ui"},
    {"from": "_extensions/git-history", "to": "_libs/sandbox-contract"},
    {"from": "_extensions/git-history", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/web", "to": "_extensions/git-history"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Extensions (10 of 24)",
  "items": [
    {"label": "acceptance", "value": 3672, "display": "3.7k", "accent": "3"},
    {"label": "automations", "value": 3536, "display": "3.5k", "accent": "3"},
    {"label": "documentation", "value": 2915, "display": "2.9k", "accent": "3"},
    {"label": "git-history (this one)", "value": 2510, "display": "2.5k", "accent": "3"},
    {"label": "workflows", "value": 2214, "display": "2.2k", "accent": "3"},
    {"label": "pipelines", "value": 1688, "display": "1.7k", "accent": "3"},
    {"label": "maintenance", "value": 1531, "display": "1.5k", "accent": "3"},
    {"label": "discord", "value": 1321, "display": "1.3k", "accent": "3"},
    {"label": "activity", "value": 1102, "display": "1.1k", "accent": "3"},
    {"label": "viewers", "value": 1068, "display": "1.1k", "accent": "3"}
  ] }
```

## Why it is a document, not a rail tile

It registers a **document**: an editor-area tab attached to a repository row, opened from the
workspace tree beside that repository's files. A repository's history is read while looking at that
repository, so the answer belongs next to it rather than behind a navigation away — the same argument
the documentation extension makes for its pages, and the same grain, a path.

Most of the package is small composables over the daemon's git routes, one per question the screen
asks. The parts worth reading on their own are the pure ones: `graphLayout.ts` turns a commit list
into lanes, `groupBranches.ts` decides what the branch switcher shows, and both are tested without a
repository.

## Where it is used

Bundled with the app. It appears on every repository row, the moment one is cloned or scaffolded.
