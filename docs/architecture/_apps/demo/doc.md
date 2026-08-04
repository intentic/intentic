# @intentic-dev/demo

The landing page's playable demo — the real editor, running on a recording.

```stats
{
  "items": [
    {"label": "Lines", "value": "4.7k"},
    {"label": "Files", "value": "22"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

A screenshot cannot show what an agent does, and a live sandbox for every visitor is a bill and a
security surface. So the marketing site ships the **actual** browser app and lies to it about the
world: a fake platform and a fake daemon are installed on the two globals the app reaches the outside
through, credentials are seeded so the router's gates open, and then the app's own entry point is
imported. Nothing in the app knows.

```dag
{ "title": "Its neighbours", "direction": "LR",
  "nodes": [
    {"id": "_apps/demo", "label": "demo", "note": "this package", "accent": "neutral"},
    {"id": "_apps/web", "label": "web", "note": "it uses", "accent": "1"},
    {"id": "_libs/api-contract", "label": "api-contract", "note": "it uses", "accent": "neutral"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/site", "label": "site", "note": "uses it", "accent": "neutral"}
  ],
  "edges": [
    {"from": "_apps/demo", "to": "_apps/web"},
    {"from": "_apps/demo", "to": "_libs/api-contract"},
    {"from": "_apps/demo", "to": "_libs/sandbox-contract"},
    {"from": "_apps/demo", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/site", "to": "_apps/demo", "dashed": true}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Account & website",
  "items": [
    {"label": "prisma", "value": 16274, "display": "16.3k", "accent": "neutral"},
    {"label": "demo (this one)", "value": 4749, "display": "4.7k", "accent": "neutral"},
    {"label": "api", "value": 3918, "display": "3.9k", "accent": "neutral"},
    {"label": "site-content", "value": 2654, "display": "2.7k", "accent": "neutral"},
    {"label": "site", "value": 1316, "display": "1.3k", "accent": "neutral"},
    {"label": "capability-catalog", "value": 1002, "display": "1.0k", "accent": "neutral"},
    {"label": "api-contract", "value": 693, "display": "693", "accent": "neutral"},
    {"label": "astro-integrations", "value": 662, "display": "662", "accent": "neutral"}
  ] }
```

## Why it is a package and not a folder in the editor

The dependency runs one way: this package imports the editor, and the editor has never heard of it.
That boundary is what stops a fixture edit from re-releasing the product, and what stops app code
from reading demo data by accident.

The interesting file is `src/fixture/workspace.ts`. It is one flat path-to-content table, and every
surface whose real state is files — the acceptance stories, the published documents, the maintenance
run history — is fixtured by adding paths to it. The extensions then walk exactly what they would
walk against a real daemon, rather than being special-cased for the demo.

## Where it is used

Built into `_apps/site/public/demo/`, which the marketing site serves behind its hero. The site
depends on it only so that it is built first — no code imports it.
