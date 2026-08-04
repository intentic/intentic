# @intentic/ext-acp-agents

Other companies' coding agents, offered as chat providers.

```stats
{
  "items": [
    {"label": "Files", "value": "2", "note": "no code \u2014 one manifest"},
    {"label": "Used by", "value": "0 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

The chat is not tied to one model vendor: anything that speaks the Agent Client Protocol over stdio
can be a provider. This extension is the list of the ones worth offering by name — OpenCode, Gemini
CLI — plus a generic entry for any other, each with the command to run it, the fields it needs and the
sign-in instructions.

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
    {"label": "acp-agents (this one)", "value": 0, "display": "0", "accent": "3"}
  ] }
```

## It contains no code

The package is a manifest and nothing else. Everything an entry declares is data the app already knows
how to render: the capability card, its fields, which of them are secret, and the guide shown while
connecting. Adding an agent is a manifest edit, and nothing about it can break at runtime.

The protocol side is elsewhere. What actually spawns the agent and drives it is the daemon's turn
planner (`_apps/sandbox/src/agent/turn-plan.ts`); this package only decides what appears on the
Capabilities screen and under which name.

## Where it is used

Bundled with the app. Its entries appear as capability cards, and then as providers in the chat's model picker.
