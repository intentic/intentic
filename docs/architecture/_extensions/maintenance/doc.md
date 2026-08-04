# @intentic/ext-maintenance

The chore book: what routine upkeep each repository is owed, and the turn that does it.

```stats
{
  "items": [
    {"label": "Lines", "value": "1.5k"},
    {"label": "Files", "value": "15"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

A workspace accumulates upkeep nobody schedules — stale documents, unpinned dependencies, tests that
have not run. This surface holds the list of chores, the evidence that decided each one, the history
of runs against them, and the controls to snooze one or start an agent on it.

```dag
{ "title": "Its neighbours", "direction": "LR",
  "nodes": [
    {"id": "_extensions/maintenance", "label": "maintenance", "note": "this package", "accent": "3"},
    {"id": "_libs/extension-api", "label": "extension-api", "note": "it uses", "accent": "3"},
    {"id": "_libs/extension-ui", "label": "extension-ui", "note": "it uses", "accent": "3"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/web", "label": "web", "note": "uses it", "accent": "1"}
  ],
  "edges": [
    {"from": "_extensions/maintenance", "to": "_libs/extension-api"},
    {"from": "_extensions/maintenance", "to": "_libs/extension-ui"},
    {"from": "_extensions/maintenance", "to": "_libs/sandbox-contract"},
    {"from": "_extensions/maintenance", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/web", "to": "_extensions/maintenance"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Extensions (10 of 24)",
  "items": [
    {"label": "acceptance", "value": 3672, "display": "3.7k", "accent": "3"},
    {"label": "automations", "value": 3536, "display": "3.5k", "accent": "3"},
    {"label": "documentation", "value": 2915, "display": "2.9k", "accent": "3"},
    {"label": "git-history", "value": 2510, "display": "2.5k", "accent": "3"},
    {"label": "workflows", "value": 2214, "display": "2.2k", "accent": "3"},
    {"label": "pipelines", "value": 1688, "display": "1.7k", "accent": "3"},
    {"label": "maintenance (this one)", "value": 1531, "display": "1.5k", "accent": "3"},
    {"label": "discord", "value": 1321, "display": "1.3k", "accent": "3"},
    {"label": "activity", "value": 1102, "display": "1.1k", "accent": "3"},
    {"label": "viewers", "value": 1068, "display": "1.1k", "accent": "3"}
  ] }
```

## Always present, badge for the news

The rail tile is workspace-wide rather than per repository, because the question is "what is this
workspace owed" and the answer is read across repos. It also activates on any repository rather than
on evidence of a problem — gating it would mean the first time an owner sees this screen is the first
time it has bad news, and would make the empty state, the state most worth being able to reach, the
one state you cannot navigate to. The badge carries the signal; the tile carries the place.

Its state is files. The manifest declares `.intentic/chores/` as the path that invalidates its
queries, so a run writing its result is what refreshes the screen — no polling of a separate store.

## Where it is used

Bundled with the app. One rail tile, plus a per-repository panel in the workspace tree.
