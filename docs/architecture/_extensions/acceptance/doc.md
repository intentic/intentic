# @intentic/ext-acceptance

Writes down what the product promises, then has agents check it in a real browser.

```stats
{ "items": [
    {"label": "Lines", "value": "3.3k"},
    {"label": "Files", "value": "23"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

A test suite proves the code does what the code says. It cannot tell you the sign-in flow is confusing. Agents walking the running app can.

A story is one markdown file in a repository's `docs/user-stories/`, and a subdirectory of that is a **group** — the unit this package organises everything by. A group is a heading in the list, the place a new story is authored into, and the thing a run picks an address for: one address per group rather than per repository, so a monorepo whose marketing site and web app are two dev servers on two ports can have both walked in a single run.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_extensions/acceptance", "label": "acceptance", "note": "this package", "accent": "3"},
    {"id": "_libs/extension-api", "label": "extension-api", "note": "it uses", "accent": "3"},
    {"id": "_libs/extension-ui", "label": "extension-ui", "note": "it uses", "accent": "3"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/web", "label": "web", "note": "uses it", "accent": "1"}
  ],
  "edges": [
    {"from": "_extensions/acceptance", "to": "_libs/extension-api"},
    {"from": "_extensions/acceptance", "to": "_libs/extension-ui"},
    {"from": "_extensions/acceptance", "to": "_libs/sandbox-contract"},
    {"from": "_extensions/acceptance", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/web", "to": "_extensions/acceptance"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Extensions (10 of 15)",
  "items": [
    {"label": "acceptance (this one)", "value": 3287, "display": "3.3k", "accent": "3"},
    {"label": "documentation", "value": 2374, "display": "2.4k", "accent": "3"},
    {"label": "automations", "value": 2143, "display": "2.1k", "accent": "3"},
    {"label": "pipelines", "value": 1545, "display": "1.5k", "accent": "3"},
    {"label": "discord", "value": 1321, "display": "1.3k", "accent": "3"},
    {"label": "repo-apps", "value": 1025, "display": "1.0k", "accent": "3"},
    {"label": "imap", "value": 989, "display": "989", "accent": "3"},
    {"label": "memory", "value": 914, "display": "914", "accent": "3"},
    {"label": "preview", "value": 658, "display": "658", "accent": "3"},
    {"label": "extension-api", "value": 605, "display": "605", "accent": "3"}
  ] }
```

## Where it is used

One tile in the sidebar; one agent session per story, with screenshots and a report. Nothing is stored for a run beyond files: the manifest under `.intentic/acceptance/` records which address each group was walked against, and that record is also what the run dialog offers back the next time.
