# @intentic/ext-connectors

A pile of ready-made tool connections — GitHub, Postgres, Sentry and friends.

```stats
{ "items": [
    {"label": "Lines", "value": "0"},
    {"label": "Files", "value": "0"},
    {"label": "Used by", "value": "0 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

Connecting an agent to an outside service is nearly always the same shape: some credentials, some environment variables, a cheat-sheet. Writing that as data means no new code per service.

This is one of four packs that work this way, and they are siblings rather than one big list on purpose. `social` holds the sites the agent signs in to as the owner, `computers` the operating-system guides a connected machine installs, `acp-agents` the outside chat agents. Splitting them means the on/off switch in the Extensions tab is worth using: turning off the social pack removes three cards and leaves your database connections alone. All four are copied into the sandbox image, so their cards are simply there on a fresh sandbox.

```bars
{ "title": "Size within Extensions (10 of 15)",
  "items": [
    {"label": "acceptance", "value": 3287, "display": "3.3k", "accent": "3"},
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

No code at all — pure manifest data. The sandbox reads it to find out what a provider needs and what to tell
the agent about it; the browser app reads it to draw the card. Adding a service is a manifest entry and a
markdown cheat-sheet, with no release of anything else.
