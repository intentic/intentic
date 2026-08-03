# @intentic/sync

Keeps folders on your computer in step with your sandboxes.

```stats
{ "items": [
    {"label": "Lines", "value": "2.3k"},
    {"label": "Files", "value": "14"},
    {"label": "Used by", "value": "0 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Some people want their own editor and their own terminal. This mirrors files both ways and forwards ports, so a dev server in the cloud behaves like one on your laptop.

One agent per computer, **many sandboxes**. Each paired sandbox is an entry in one state file, with its own local folder, its own ssh alias and its own Mutagen session; a single resident watcher walks that list every few seconds. This is the part worth knowing, because the agent used to hold exactly one pairing and treated a new `setup` as replacing a dead one — so pairing a second sandbox on the same computer silently stopped syncing the first one's folder. Adding a pairing is now purely additive, and sessions are retired only when no pairing claims them.

Two sandboxes often serve the same dev-server port, and only one can own `localhost:6480`. First paired wins; the other is told which sandbox holds it.

The agent's ports poll doubles as a **heartbeat**. It is the only thing a live sync does on its own, so the sandbox records when it last arrived, and the Desktop sync card reports a machine that has gone quiet instead of trusting the enrollment record forever.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_apps/sync", "label": "sync", "note": "this package", "accent": "2"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"}
  ],
  "edges": [
    {"from": "_apps/sync", "to": "_libs/sandbox-contract"},
    {"from": "_apps/sync", "to": "_tools/tsconfig", "dashed": true}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within The sandbox",
  "items": [
    {"label": "sandbox", "value": 67899, "display": "67.9k", "accent": "2"},
    {"label": "sandbox-contract", "value": 7251, "display": "7.3k", "accent": "2"},
    {"label": "sync (this one)", "value": 2257, "display": "2.3k", "accent": "2"},
    {"label": "scaffold", "value": 1909, "display": "1.9k", "accent": "2"},
    {"label": "acp-bridge", "value": 991, "display": "991", "accent": "2"},
    {"label": "sandbox-run", "value": 440, "display": "440", "accent": "2"},
    {"label": "workspace-setup", "value": 270, "display": "270", "accent": "2"},
    {"label": "workspace-ignore", "value": 214, "display": "214", "accent": "2"}
  ] }
```

## Where it is used

Runs on your own machine, not in the sandbox. Optional.
