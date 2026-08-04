# @intentic/ext-workflows

Designed graphs of agent sessions, each step producing a declared output.

```stats
{
  "items": [
    {"label": "Lines", "value": "2.2k"},
    {"label": "Files", "value": "19"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Some work is a pipeline rather than a conversation: research, then draft, then review, each step a
fresh agent handed the previous step's output. This surface is where such a graph is drawn, saved and
run, and where a run is watched step by step.

```dag
{ "title": "Its neighbours", "direction": "LR",
  "nodes": [
    {"id": "_extensions/workflows", "label": "workflows", "note": "this package", "accent": "3"},
    {"id": "_libs/extension-api", "label": "extension-api", "note": "it uses", "accent": "3"},
    {"id": "_libs/extension-ui", "label": "extension-ui", "note": "it uses", "accent": "3"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/web", "label": "web", "note": "uses it", "accent": "1"}
  ],
  "edges": [
    {"from": "_extensions/workflows", "to": "_libs/extension-api"},
    {"from": "_extensions/workflows", "to": "_libs/extension-ui"},
    {"from": "_extensions/workflows", "to": "_libs/sandbox-contract"},
    {"from": "_extensions/workflows", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/web", "to": "_extensions/workflows"}
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
    {"label": "workflows (this one)", "value": 2214, "display": "2.2k", "accent": "3"},
    {"label": "pipelines", "value": 1688, "display": "1.7k", "accent": "3"},
    {"label": "maintenance", "value": 1531, "display": "1.5k", "accent": "3"},
    {"label": "discord", "value": 1321, "display": "1.3k", "accent": "3"},
    {"label": "activity", "value": 1102, "display": "1.1k", "accent": "3"},
    {"label": "viewers", "value": 1068, "display": "1.1k", "accent": "3"}
  ] }
```

## One graph derivation, two screens

The designer and the run view draw the same picture from the same module. That is deliberate and it
is the reason `workflowDag.ts` exists rather than two components' worth of computed properties: a
designer whose preview lays out differently from the run would be worse than no preview, because you
would trust it. Whether a node carries run state is what tells the shared card which mode it is in.

Workflows are native to every sandbox — there is no capability to enable — so the rail tile appears
unconditionally. Its state is two files under `.intentic/`, declared in the manifest, so a run
writing progress is what refreshes the screen.

## Where it is used

Bundled with the app. One rail tile, with the designer and the run view behind it.
