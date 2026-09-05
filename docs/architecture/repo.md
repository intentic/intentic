# intentic, in pictures

A private box per project. Your code lives in it, AI agents work in it, and you watch through a browser.

```stats
{ "items": [
    {"label": "Packages", "value": "70"},
    {"label": "Lines of code", "value": "333.0k"},
    {"label": "Parts", "value": "9", "note": "one directory each"},
    {"label": "With tests", "value": "47 of 70"}
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
    {"id": "devices", "label": "Your devices", "note": "your own machines", "accent": "neutral"},
    {"id": "account", "label": "Account", "note": "sign-in, sandbox registry", "accent": "neutral"},
    {"id": "site", "label": "The website", "note": "public pages", "accent": "neutral"}
  ],
  "edges": [
    {"from": "you", "to": "editor"},
    {"from": "you", "to": "site", "dashed": true},
    {"from": "editor", "to": "sandbox"},
    {"from": "editor", "to": "extensions"},
    {"from": "editor", "to": "account", "dashed": true},
    {"from": "extensions", "to": "sandbox"},
    {"from": "sandbox", "to": "agents"},
    {"from": "agents", "to": "search"},
    {"from": "agents", "to": "devices", "dashed": true},
    {"from": "sandbox", "to": "deploy", "dashed": true}
  ] }
```

Notice what is *not* connected: sign-in and the website sit to one side, the deployment engine hangs off the
sandbox as a tool it can run, and your own computer is reached only when you grant it. None of them are in the
way of you and your code.

Every part below is one top-level directory: the layout *is* this map, so a package's path tells you which
part it belongs to before you open it.

## What each part is for

**The editor** (`_editor/`) (The screen you actually look at) files, chat, terminals. · 4 packages, 105.0k lines

**The sandbox** (`_sandbox/`): One private box per project, where your code and the agents live. · 11 packages, 116.8k lines

**Extensions** (`_extensions/`): How features are added without touching the core. · 21 packages, 29.4k lines

**Your devices** (`_devices/`) (How an agent reaches a machine of your own) with your permission, within your switches. · 4 packages, 4.8k lines

**Code search** (`_search/`): How an agent finds the right file instead of reading everything. · 5 packages, 14.5k lines

**Deployment engine** (`_deploy/`): A bundled tool that turns 'what I want' into running servers. Not part of the product. · 8 packages, 27.5k lines

**Account** (`_platform/`): Sign-in and the sandbox registry. Off to one side of everything else. · 4 packages, 22.1k lines

**The website** (`_site/`): The public site and its playable demo. · 4 packages, 9.8k lines

**Plumbing** (`_tools/`): Shared config and test harnesses. · 9 packages, 3.0k lines

```bars
{ "title": "Size of each part",
  "items": [
    {"label": "The sandbox", "value": 116806, "display": "116.8k", "accent": "2"},
    {"label": "The editor", "value": 105045, "display": "105.0k", "accent": "1"},
    {"label": "Extensions", "value": 29445, "display": "29.4k", "accent": "3"},
    {"label": "Deployment engine", "value": 27487, "display": "27.5k", "accent": "5"},
    {"label": "Account", "value": 22127, "display": "22.1k", "accent": "neutral"},
    {"label": "Code search", "value": 14452, "display": "14.5k", "accent": "4"},
    {"label": "The website", "value": 9815, "display": "9.8k", "accent": "neutral"},
    {"label": "Your devices", "value": 4838, "display": "4.8k", "accent": "neutral"},
    {"label": "Plumbing", "value": 2978, "display": "3.0k", "accent": "neutral"}
  ] }
```

## The ten biggest packages

```bars
{ "title": "Lines of code",
  "items": [
    {"label": "_editor/web", "value": 95392, "display": "95.4k", "accent": "1"},
    {"label": "_sandbox/sandbox", "value": 92307, "display": "92.3k", "accent": "2"},
    {"label": "_platform/prisma", "value": 16274, "display": "16.3k", "accent": "neutral"},
    {"label": "_sandbox/sandbox-contract", "value": 13891, "display": "13.9k", "accent": "2"},
    {"label": "_deploy/providers", "value": 13778, "display": "13.8k", "accent": "5"},
    {"label": "_editor/ui", "value": 8758, "display": "8.8k", "accent": "1"},
    {"label": "_search/iq-engine", "value": 7223, "display": "7.2k", "accent": "4"},
    {"label": "_deploy/cli", "value": 6421, "display": "6.4k", "accent": "5"},
    {"label": "_site/demo", "value": 5181, "display": "5.2k", "accent": "neutral"},
    {"label": "_platform/api", "value": 4069, "display": "4.1k", "accent": "neutral"}
  ] }
```

Two packages are most of the product. That is expected: one is the screen, one is the box.

## Which packages everything else leans on

```bars
{ "title": "Number of packages depending on it",
  "items": [
    {"label": "_tools/tsconfig", "value": 60, "accent": "neutral"},
    {"label": "_sandbox/sandbox-contract", "value": 28, "accent": "2"},
    {"label": "_sandbox/extension-api", "value": 20, "accent": "2"},
    {"label": "_editor/extension-ui", "value": 15, "accent": "1"},
    {"label": "_tools/testing", "value": 12, "accent": "neutral"},
    {"label": "_deploy/graph", "value": 10, "accent": "5"},
    {"label": "_tools/constants", "value": 7, "accent": "neutral"},
    {"label": "_deploy/sdk", "value": 5, "accent": "5"}
  ] }
```

A shared rulebook and a shared config sit at the bottom of everything. Break either and the whole repo notices.

## Where to start reading

1. **_editor/web** (The browser app) the whole editor you see and click.
2. **_sandbox/sandbox-contract**: The rulebook both sides of the wire agree on.
3. **_sandbox/sandbox** (The daemon) the program running inside your project's box.
4. **_sandbox/extension-api**: The contract an extension is written against.
5. **_search/iq**: One search command an agent can actually use.

## Words used here in a particular way

- **sandbox** (One private box per project. Your files, your agents, your terminals) nobody else's.
- **the daemon**: The program running inside a sandbox that owns the files and answers the editor.
- **agent**: One AI conversation doing one job. Several can run at once, each on its own copy of the code.
- **turn**, One round of an agent working: you ask, it acts, it reports.
- **worktree**: A private copy of the code an isolated agent works in, so parallel agents cannot collide.
- **the rail**: The strip of icons down the left of the editor. Space there is scarce and earned.
- **extension**: A package that adds screens, commands or agent tools without changing the core app.
- **capability** (Something you have connected) a GitHub account, a database, an API key.
- **panel**: A repo's own dev server, run by the sandbox and shown in a frame.
- **intent**: A description of what you want to exist. The deployment engine's input, not the product's.
- **the app plane**: The product you look at. Separate from the deployment engine, which is a bundled tool.
