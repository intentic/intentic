# @intentic/registry

The file format an extension registry is written in.

```stats
{
  "items": [
    {"label": "Lines", "value": "369"},
    {"label": "Files", "value": "6"},
    {"label": "Used by", "value": "5 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

intentic hosts no extension code, builds none and signs none. A registry is a git repo of pointers:
each entry names somebody else's repository at a commit, and installing follows that pointer from the
owner's sandbox straight to the author's git host. Listing costs a pull request; delisting removes a
pointer and deletes nothing. This package is the schema for that repo, and the rules for reading it.

```dag
{ "title": "Its neighbours", "direction": "LR",
  "nodes": [
    {"id": "_libs/registry", "label": "_libs/registry", "note": "this package", "accent": "3"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/sandbox", "label": "sandbox", "note": "uses it", "accent": "2"},
    {"id": "_apps/site", "label": "site", "note": "uses it", "accent": "neutral"},
    {"id": "_apps/web", "label": "web", "note": "uses it", "accent": "1"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "uses it", "accent": "2"},
    {"id": "_tools/registry", "label": "_tools/registry", "note": "uses it", "accent": "3"}
  ],
  "edges": [
    {"from": "_libs/registry", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/sandbox", "to": "_libs/registry"},
    {"from": "_apps/site", "to": "_libs/registry"},
    {"from": "_apps/web", "to": "_libs/registry"},
    {"from": "_libs/sandbox-contract", "to": "_libs/registry"},
    {"from": "_tools/registry", "to": "_libs/registry"}
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
    {"label": "maintenance", "value": 1531, "display": "1.5k", "accent": "3"},
    {"label": "discord", "value": 1321, "display": "1.3k", "accent": "3"},
    {"label": "activity", "value": 1102, "display": "1.1k", "accent": "3"},
    {"label": "registry (this one)", "value": 369, "display": "369", "accent": "3"}
  ] }
```

## Why the format is two files

The curated file holds every decision — what is listed, at which commit, at what trust level — and is
edited by humans through pull requests. A second, generated file holds only facts read back off the
source host, such as stars and last push date. Keeping them apart is load-bearing: star counts in the
hand-edited file would make each nightly refresh a merge conflict against every open listing request,
and would bury the decision under churn in the review diff.

Two smaller rules carry most of the safety. An entry's identity is derived from the extension's own
manifest rather than declared by the registry, so a repo that copies someone else's manifest collides
with their listing instead of shadowing it. And a one-click install requires a full commit hash,
because extension code runs trusted in the owner's browser and a branch name is a promise the
upstream can break with a force-push.

## Where it is used

By the daemon that clones a registry, the website that renders the public gallery, and the scanner
that writes the generated file — one schema instead of three that drift.
