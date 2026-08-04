# @intentic/registry-scan

The nightly job that finds candidate extensions and proposes them as pull requests.

```stats
{
  "items": [
    {"label": "Lines", "value": "601"},
    {"label": "Files", "value": "7"},
    {"label": "Used by", "value": "0 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

A registry should be discoverable without being open to anyone who tags a repo. This job searches a
public topic, refreshes the upstream facts for entries already listed, and for each unlisted repo
whose manifest parses it writes out a *candidate* registry file plus the pull request text to go with
it. It never lists, delists or changes a trust level.

```dag
{ "title": "Its neighbours", "direction": "LR",
  "nodes": [
    {"id": "_tools/registry", "label": "_tools/registry", "note": "this package", "accent": "3"},
    {"id": "_libs/extension-api", "label": "extension-api", "note": "it uses", "accent": "3"},
    {"id": "_libs/registry", "label": "_libs/registry", "note": "it uses", "accent": "3"},
    {"id": "_libs/testing", "label": "testing", "note": "it uses", "accent": "neutral"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"}
  ],
  "edges": [
    {"from": "_tools/registry", "to": "_libs/extension-api"},
    {"from": "_tools/registry", "to": "_libs/registry"},
    {"from": "_tools/registry", "to": "_libs/testing", "dashed": true},
    {"from": "_tools/registry", "to": "_tools/tsconfig", "dashed": true}
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
    {"label": "registry (this one)", "value": 601, "display": "601", "accent": "3"}
  ] }
```

## Discovery and decision are different jobs

A topic is a public namespace anybody can join, so a job that published what it found would list the
first malicious repository to tag itself. The alternative — a submission form on the website — is a
login, a spam queue and an admin panel standing in for a git commit. Keeping the two apart is the
whole design, and it is why the output of a run is a proposal rather than a change.

One rule it does enforce alone: the listing key is read from the candidate's own manifest, so a
repository that copies somebody else's manifest collides with their listing and is refused here,
rather than arriving as a pull request that looks legitimate.

## Where it is used

Published to npm and run by a GitHub Action inside the registry repository, which this monorepo does
not contain. `seed/` is what that repository starts as — a starting point, not a synced copy.
