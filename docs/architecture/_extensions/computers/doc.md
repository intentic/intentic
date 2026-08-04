# @intentic/ext-computers

The Windows and Linux capability cards for connecting your own computer.

```stats
{
  "items": [
    {"label": "Files", "value": "4", "note": "no code \u2014 manifest and skills"},
    {"label": "Used by", "value": "0 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

Connecting a personal machine to a sandbox is a card on the Capabilities screen, and the card has to
carry everything a person needs to be willing to do it: what the agent will be able to touch, that
the connection is outbound so nothing on their network is opened, and how to revoke it. This package
is those two cards, plus the skill file that tells the agent how to use a machine once it is there.

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
    {"label": "computers (this one)", "value": 0, "display": "0", "accent": "3"}
  ] }
```

## Data plus a skill, no code

There is no runtime here. The manifest declares two `host` capabilities and points each at a skill
document — instructions the agent reads when it is about to work on that operating system, which is
where per-platform advice belongs rather than in the tool descriptions.

The machinery lives in three other places: `_apps/host` runs on the computer, `_libs/desktop` and
`_libs/browser` are what it works through, and `_apps/sandbox/src/hosts/` is the sandbox's end.
Splitting the *card* out means the wording a user reads before granting access can be changed without
touching any of them.

## Where it is used

Bundled with the app. Adding a card here is what makes a connected machine appear in the sandbox's tool surface.
