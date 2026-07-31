# intentic, in pictures

A private box per project. Your code lives in it, AI agents work in it, and you watch through a browser.

```stats
{ "items": [
    {"label": "Packages", "value": "54"},
    {"label": "Lines of code", "value": "235.3k"},
    {"label": "Parts", "value": "7", "note": "groups below"},
    {"label": "With tests", "value": "32 of 54"}
  ] }
```

## The whole thing on one screen

```dag
{ "title": "How the parts relate",
  "direction": "LR",
  "nodes": [
    {"id": "you", "label": "You", "note": "a browser", "accent": "neutral"},
    {"id": "editor", "label": "The editor", "note": "what you look at", "accent": "1"},
    {"id": "extensions", "label": "Extensions", "note": "added features", "accent": "3"},
    {"id": "sandbox", "label": "The sandbox", "note": "your project's box", "accent": "2"},
    {"id": "agents", "label": "Agents", "note": "AI doing the work", "accent": "2"},
    {"id": "search", "label": "Code search", "note": "how they find code", "accent": "4"},
    {"id": "deploy", "label": "Deployment engine", "note": "a bundled tool", "accent": "5"},
    {"id": "account", "label": "Account", "note": "sign-in, billing", "accent": "neutral"}
  ],
  "edges": [
    {"from": "you", "to": "editor"},
    {"from": "editor", "to": "sandbox"},
    {"from": "editor", "to": "extensions"},
    {"from": "editor", "to": "account", "dashed": true},
    {"from": "extensions", "to": "sandbox"},
    {"from": "sandbox", "to": "agents"},
    {"from": "agents", "to": "search"},
    {"from": "sandbox", "to": "deploy", "dashed": true}
  ] }
```

Notice what is *not* connected: sign-in sits to one side, and the deployment engine hangs off the sandbox as a
tool it can run. Neither is in the way of you and your code.

## What each part is for

**The editor** — The screen you actually look at — files, chat, terminals. · 2 packages, 85.1k lines

**The sandbox** — One private box per project, where your code and the agents live. · 8 packages, 81.2k lines

**Extensions** — How features are added without touching the core. · 15 packages, 15.7k lines

**Code search** — How an agent finds the right file instead of reading everything. · 5 packages, 13.5k lines

**Deployment engine** — A bundled tool that turns 'what I want' into running servers. Not part of the product. · 8 packages, 27.2k lines

**Account & website** — Sign-in, billing and the public site. Off to one side of everything else. · 7 packages, 7.5k lines

**Plumbing & retired code** — Shared config, test harnesses, and one abandoned experiment. · 9 packages, 5.0k lines

```bars
{ "title": "Size of each part",
  "items": [
    {"label": "The editor", "value": 85114, "display": "85.1k", "accent": "1"},
    {"label": "The sandbox", "value": 81231, "display": "81.2k", "accent": "2"},
    {"label": "Extensions", "value": 15686, "display": "15.7k", "accent": "3"},
    {"label": "Code search", "value": 13545, "display": "13.5k", "accent": "4"},
    {"label": "Deployment engine", "value": 27167, "display": "27.2k", "accent": "5"},
    {"label": "Account & website", "value": 7550, "display": "7.5k", "accent": "neutral"},
    {"label": "Plumbing & retired code", "value": 4963, "display": "5.0k", "accent": "neutral"}
  ] }
```

## The ten biggest packages

```bars
{ "title": "Lines of code",
  "items": [
    {"label": "_apps/web", "value": 77708, "display": "77.7k", "accent": "1"},
    {"label": "_apps/sandbox", "value": 67899, "display": "67.9k", "accent": "2"},
    {"label": "_libs/providers", "value": 13686, "display": "13.7k", "accent": "5"},
    {"label": "_libs/ui", "value": 7406, "display": "7.4k", "accent": "1"},
    {"label": "_libs/sandbox-contract", "value": 7251, "display": "7.3k", "accent": "2"},
    {"label": "_libs/iq-engine", "value": 6799, "display": "6.8k", "accent": "4"},
    {"label": "_apps/cli", "value": 6201, "display": "6.2k", "accent": "5"},
    {"label": "_apps/api", "value": 3611, "display": "3.6k", "accent": "neutral"},
    {"label": "_extensions/acceptance", "value": 3287, "display": "3.3k", "accent": "3"},
    {"label": "_libs/state-resolver", "value": 3033, "display": "3.0k", "accent": "5"}
  ] }
```

Two packages are most of the product. That is expected: one is the screen, one is the box.

## Which packages everything else leans on

```bars
{ "title": "Number of packages depending on it",
  "items": [
    {"label": "_tools/tsconfig", "value": 46, "accent": "neutral"},
    {"label": "_libs/sandbox-contract", "value": 21, "accent": "2"},
    {"label": "_libs/extension-api", "value": 14, "accent": "3"},
    {"label": "_libs/extension-ui", "value": 11, "accent": "3"},
    {"label": "_libs/graph", "value": 10, "accent": "5"},
    {"label": "_tools/constants", "value": 7, "accent": "neutral"},
    {"label": "_libs/sandbox-run", "value": 5, "accent": "2"},
    {"label": "_libs/sdk", "value": 5, "accent": "5"}
  ] }
```

A shared rulebook and a shared config sit at the bottom of everything. Break either and the whole repo notices.

## Where to start reading

1. **_apps/web** — The browser app — the whole editor you see and click.
2. **_libs/sandbox-contract** — The rulebook both sides of the wire agree on.
3. **_apps/sandbox** — The daemon — the program running inside your project's box.
4. **_libs/extension-api** — The contract an extension is written against.
5. **_apps/iq** — One search command an agent can actually use.

## Words used here in a particular way

- **sandbox** — One private box per project. Your files, your agents, your terminals — nobody else's.
- **the daemon** — The program running inside a sandbox that owns the files and answers the editor.
- **agent** — One AI conversation doing one job. Several can run at once, each on its own copy of the code.
- **turn** — One round of an agent working: you ask, it acts, it reports.
- **worktree** — A private copy of the code an isolated agent works in, so parallel agents cannot collide.
- **the rail** — The strip of icons down the left of the editor. Space there is scarce and earned.
- **extension** — A package that adds screens, commands or agent tools without changing the core app.
- **capability** — Something you have connected — a GitHub account, a database, an API key.
- **panel** — A repo's own dev server, run by the sandbox and shown in a frame.
- **intent** — A description of what you want to exist. The deployment engine's input, not the product's.
- **the app plane** — The product you look at. Separate from the deployment engine, which is a bundled tool.
