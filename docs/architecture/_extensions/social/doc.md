# @intentic/ext-social

Reddit, X and YouTube — the agent acting as you, in a real logged-in browser.

```stats
{
  "items": [
    {"label": "Files", "value": "5", "note": "no code \u2014 manifest and skills"},
    {"label": "Used by", "value": "0 packages"},
    {"label": "Tests", "value": "no"}
  ] }
```

## The problem it solves

These platforms either have no useful API or gate it behind an approval process, and an API key would
be a different identity from the owner's account anyway. So the agent uses a browser the owner signed
into once, in a window they watched. This package is the three cards that offer that, and the skill
documents that tell the agent how each site works.

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
    {"label": "social (this one)", "value": 0, "display": "0", "accent": "3"}
  ] }
```

## Data plus skills, no code

Each entry declares a `browser` capability, a sign-in URL and a skill file. The browser session and
its persistence belong to the sandbox; what is here is the offer, the warning that automating an
account may be against the platform's terms, and the site-specific instructions.

The skill files are short on purpose — a page each. They say what the agent is allowed to do on that
site and what the browser tools are called; how to click a particular button is something it works
out by looking, which is the point of driving a real browser rather than an API.

## Where it is used

Bundled with the app. Three capability cards, each unlocking the matching skill for the agent.
