# @intentic/ext-deployments

What is running right now, what just broke, and the buttons to do something about it.

```stats
{ "items": [
    {"label": "Lines", "value": "1.0k"},
    {"label": "Files", "value": "11"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

The rail could already tell you CI went red. It could not tell you production went down.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_extensions/deployments", "label": "deployments", "note": "this package", "accent": "3"},
    {"id": "_libs/extension-api", "label": "extension-api", "note": "it uses", "accent": "3"},
    {"id": "_libs/extension-ui", "label": "extension-ui", "note": "it uses", "accent": "3"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/web", "label": "web", "note": "uses it", "accent": "1"}
  ],
  "edges": [
    {"from": "_extensions/deployments", "to": "_libs/extension-api"},
    {"from": "_extensions/deployments", "to": "_libs/extension-ui"},
    {"from": "_extensions/deployments", "to": "_libs/sandbox-contract"},
    {"from": "_extensions/deployments", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/web", "to": "_extensions/deployments"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

## What the tile is allowed to say

`incidents.ts` is the whole design, and it is worth reading before changing anything here. The obvious badge —
count the deployments that are not running — is a **level**, and a level badge is lit whenever the level is
high, which on an estate with anything deliberately stopped is always. That teaches the eye to stop seeing the
rail, which costs the badge its one job.

So it counts **edges**, and it does not have to derive them: Komodo's alert log already records the
transition, timestamped and with a `resolved` flag it closes when the condition clears. A container that left
`running`, a host that went unreachable, a build that failed. Thresholds are `warning`. Image updates are
`info` and never `danger` — a routine version bump must not spend the colour that means production is down.
A Komodo we cannot reach is a `warning` with no count, because "we cannot see production" is not "production
is broken".

It clears by **looking**, not by fixing. The incident stays visibly in the panel for as long as it is real; the
rail simply stops repeating itself.

## Where it is used

One sidebar tile per connected Komodo, reading the daemon's `/komodo/{capability}` routes — the credential
never enters the browser. Grouped by host rather than by resource type, because the question during an
incident is "is this one app, or is it the box?".
