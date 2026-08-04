# @intentic/testing

The stand-in every test suite builds its fakes on, plus the two suite budgets.

```stats
{
  "items": [
    {"label": "Lines", "value": "145"},
    {"label": "Files", "value": "4"},
    {"label": "Used by", "value": "12 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Testing a module that hangs off a wide interface — a 37-method git, a 130-member service tree — means
either writing 35 no-op stubs that say nothing and go stale, or standing the thing in one level deep
and getting "seenAt is not a function" when something two levels down is missing. This package's
stand-in answers any unprovided member to any depth, and throws naming the whole path it was reached
by. A suite then provides only what the code under test touches, and a new required member of the
interface needs no edit anywhere.

```dag
{ "title": "Its neighbours (showing 1 of 1 it uses, 5 of 12 that use it)", "direction": "LR",
  "nodes": [
    {"id": "_libs/testing", "label": "testing", "note": "this package", "accent": "neutral"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/cli", "label": "cli", "note": "uses it", "accent": "5"},
    {"id": "_apps/sandbox", "label": "sandbox", "note": "uses it", "accent": "2"},
    {"id": "_apps/sync", "label": "sync", "note": "uses it", "accent": "2"},
    {"id": "_libs/iq-engine", "label": "iq-engine", "note": "uses it", "accent": "4"},
    {"id": "_libs/providers", "label": "providers", "note": "uses it", "accent": "5"}
  ],
  "edges": [
    {"from": "_libs/testing", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/cli", "to": "_libs/testing", "dashed": true},
    {"from": "_apps/sandbox", "to": "_libs/testing", "dashed": true},
    {"from": "_apps/sync", "to": "_libs/testing", "dashed": true},
    {"from": "_libs/iq-engine", "to": "_libs/testing", "dashed": true},
    {"from": "_libs/providers", "to": "_libs/testing", "dashed": true}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Plumbing",
  "items": [
    {"label": "e2e", "value": 1864, "display": "1.9k", "accent": "neutral"},
    {"label": "examples", "value": 163, "display": "163", "accent": "neutral"},
    {"label": "testing (this one)", "value": 145, "display": "145", "accent": "neutral"},
    {"label": "constants", "value": 54, "display": "54", "accent": "neutral"},
    {"label": "desktop-smoke", "value": 0, "display": "0", "accent": "neutral"},
    {"label": "dind-host", "value": 0, "display": "0", "accent": "neutral"},
    {"label": "localhost-https", "value": 0, "display": "0", "accent": "neutral"},
    {"label": "tsconfig", "value": 0, "display": "0", "accent": "neutral"}
  ] }
```

## The copies were the bug

Two packages each grew their own version of this, and the two drifted the moment they were written —
one of them answered a missing nested member with a throwing function one level deep, and neither
guarded the keys the *language* reads off an arbitrary value. A value carrying a callable `then` is a
promise as far as the runtime is concerned, so awaiting the fake hands the resolution machinery a
stand-in that it then calls. Eight tests died inside the await machinery before that was understood.

The other half of the package is `vitest.ts`: the two suite kinds as config data. A five-second
timeout is a hang detector, correct for a test that composes objects in memory and nonsense for one
that clones a repo or boots a container. The kind is in the file name, so the ceiling follows the kind
rather than being repaired suite by suite after it breaks a busy CI runner.

## Where it is used

A development-only dependency of packages across the repo. Consumed from source; nothing here ships.
