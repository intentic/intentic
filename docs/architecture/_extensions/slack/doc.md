# @intentic/ext-slack

A connected Slack workspace, as an agent tool and as a thing that can wake the agent.

```stats
{
  "items": [
    {"label": "Lines", "value": "1.0k"},
    {"label": "Files", "value": "9"},
    {"label": "Used by", "value": "0 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

Slack is two features wearing one name. Outbound is a tool: read, post and react as the connected
app. Inbound is a wake-up — somebody mentions the bot and a turn should start, in that thread, with
that conversation as context. This package is both halves.

```dag
{ "title": "Its neighbours", "direction": "LR",
  "nodes": [
    {"id": "_extensions/slack", "label": "slack", "note": "this package", "accent": "3"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"}
  ],
  "edges": [
    {"from": "_extensions/slack", "to": "_tools/tsconfig", "dashed": true}
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
    {"label": "slack (this one)", "value": 1033, "display": "1.0k", "accent": "3"}
  ] }
```

## The gateway is a process, not a webhook

The manifest declares a long-running process the sandbox starts automatically. It holds Slack's
Socket Mode connection, which means no public URL and no inbound hole in anyone's firewall — the same
outbound-only shape the host agent uses for the same reason.

Two details are worth knowing before editing the inbound path. Waking is on an **allowlist** of
message subtypes, not a denylist, because Slack keeps adding them and the cost of guessing wrong is
an agent woken by somebody joining a channel. And since Slack has no bot typing indicator, the
"I'm on it" signal is an eyes reaction added when the mention lands and removed when the turn ends.

## Where it is used

Bundled with the app. One capability card holding both tokens; the gateway starts with the sandbox
once they are set.
