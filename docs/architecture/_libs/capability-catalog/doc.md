# @intentic-app/capability-catalog

The list of things you can connect, as data.

```stats
{ "items": [
    {"label": "Lines", "value": "615"},
    {"label": "Files", "value": "3"},
    {"label": "Used by", "value": "1 packages"},
    {"label": "Tests", "value": "yes"}
  ] }
```

## The problem it solves

The 'add a connection' screen needs to know what exists, what each one needs, and how to explain it.

Half of that list does not live here. The screen shows two kinds of card side by side: **static** ones written
in this package, and **derived** ones read out of whatever extensions are installed and switched on. The rule
deciding which is which is the important thing to know about this package, and it is not about tidiness — it is
about privilege. Adding a capability runs a handler in the sandbox daemon, and some of those handlers do things
no third party should be able to ask for: grant the container full privilege, put it on a private network, push
new permissions onto somebody's personal laptop. So a handler is never something an extension supplies. A
**card** is: the name, logo, form fields and cheatsheet that differ between two things the *same* handler
already knows how to do.

Four kinds are card-shaped that way — command-line connectors, social platforms the agent signs in to, the
operating systems a connected computer can run, and presets for outside chat agents — and their cards come from
extensions. Everything still written out in `index.ts` is a card that is one-to-one with a handler it cannot be
separated from, so putting it in a manifest would split one idea across two places for nothing.

One case is worth the sentence because it looks like an exception and is not: Stripe. Its card is nothing but a
name and a logo, so it reads like pure data — but adding it writes an entry the deployment engine has to
recognise, and that engine knows a fixed list of providers. The vocabulary belongs to the engine, so the card
stays here.

```dag
{ "title": "Its neighbours",
  "direction": "LR",
  "nodes": [
    {"id": "_libs/capability-catalog", "label": "capability-catalog", "note": "this package", "accent": "neutral"},
    {"id": "_libs/extension-api", "label": "extension-api", "note": "it uses", "accent": "3"},
    {"id": "_libs/sandbox-contract", "label": "sandbox-contract", "note": "it uses", "accent": "2"},
    {"id": "_tools/tsconfig", "label": "tsconfig", "note": "it uses", "accent": "neutral"},
    {"id": "_apps/web", "label": "web", "note": "uses it", "accent": "1"}
  ],
  "edges": [
    {"from": "_libs/capability-catalog", "to": "_libs/extension-api"},
    {"from": "_libs/capability-catalog", "to": "_libs/sandbox-contract"},
    {"from": "_libs/capability-catalog", "to": "_tools/tsconfig", "dashed": true},
    {"from": "_apps/web", "to": "_libs/capability-catalog"}
  ] }
```

Dashed arrows are development-only — needed to build or test, not to run.

```bars
{ "title": "Size within Account & website",
  "items": [
    {"label": "api", "value": 3611, "display": "3.6k", "accent": "neutral"},
    {"label": "site-content", "value": 915, "display": "915", "accent": "neutral"},
    {"label": "site", "value": 905, "display": "905", "accent": "neutral"},
    {"label": "api-contract", "value": 651, "display": "651", "accent": "neutral"},
    {"label": "astro-integrations", "value": 643, "display": "643", "accent": "neutral"},
    {"label": "capability-catalog (this one)", "value": 615, "display": "615", "accent": "neutral"},
    {"label": "prisma", "value": 210, "display": "210", "accent": "neutral"}
  ] }
```

## Where it is used

Rendered by the editor's capability screens. `contributionCard()` is the one function that turns an extension's
manifest entry into a card, and it adds two things the manifest is deliberately not allowed to say: the hidden
field that ties an instance back to the card that created it, and — for a connected computer — the permission
switches, which are identical on every operating system and would be worth nothing if a card could quietly
change them.
