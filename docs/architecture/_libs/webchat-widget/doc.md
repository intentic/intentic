# @intentic/webchat-widget

Doorbell — the chat bubble a website embeds to talk to your agent.

```stats
{ "items": [
    {"label": "Lines", "value": "1112"},
    {"label": "Files", "value": "9"},
    {"label": "Bundle", "value": "6.3 kB", "note": "gzipped, one file"},
    {"label": "Tests", "value": "yes", "note": "19"}
  ] }
```

## The problem it solves

Every other way into a sandbox belongs to its owner: you sign in with Google and the daemon checks it. A
website's visitors have none of that and never will. This package is the one surface built for people the
sandbox has never heard of — a chat bubble a customer drops on their own site with a single `<script>` tag,
which streams a real agent turn back to a stranger.

```dag
{ "title": "A visitor's message, end to end", "direction": "LR",
  "nodes": [
    {"id": "site", "label": "Customer's site", "note": "widget.js", "accent": "neutral"},
    {"id": "daemon", "label": "Sandbox daemon", "note": "/webchat/*", "accent": "2"},
    {"id": "automation", "label": "Automation", "note": "listener, provider webchat", "accent": "3"},
    {"id": "turn", "label": "Agent turn", "note": "its own worktree", "accent": "2"}],
  "edges": [
    {"from": "site", "to": "daemon"},
    {"from": "daemon", "to": "automation"},
    {"from": "automation", "to": "turn"},
    {"from": "turn", "to": "site"}] }
```

What to notice: the arrow back to the site is the same turn, streaming as it is written — not a second request.

## What is surprising

**It is not a framework component.** No Vue, no build-time CSS. The widget is a custom element that renders
into a shadow root, and its stylesheet is a template string inside the bundle. Both choices are about the page
it lands on: a framework would be several times the size of the UI it draws, and a shadow root is what stops a
stranger's stylesheet from reshaping the chat. The first line of that stylesheet is `all: initial`, because a
shadow root blocks selectors but *not* inherited properties — without it the widget wears the host site's font.

**The gates are deliberately outside the shadow root.** Google's sign-in button and Cloudflare's Turnstile
checkbox are third-party iframes that expect an ordinary document-connected container. They are created as
light-DOM children of the element and projected back into the panel through a `<slot>`, so they render where
they look like they belong without either of them having to work inside a shadow root.

**The daemon serves the bundle, not a CDN.** `/webchat/widget.js` comes from the same origin as the routes it
talks to, so the widget and the wire can never be different versions and no cache anywhere holds a mismatched
pair. The cost is real and accepted: while the sandbox is asleep the script does not load, and the site simply
has no launcher.

**One `<script>` carries one piece of information.** The automation id. The daemon to talk to is the origin the
script itself came from, which is the one thing a copy-pasted snippet cannot get wrong.

## The pieces

`main.ts` boots: read the tag, fetch the config, define the element. That config fetch doubles as the
reachability probe — a sleeping sandbox, a deleted automation and a site that is not on the allowlist all land
in the same place, and in all three the right answer is to render nothing at all. A launcher that opens onto an
error is worse than no launcher.

`element.ts` is the UI and the state: the launcher, the panel, the thread, and the two gates. `transport.ts`
holds the four calls and the reply reader — the daemon answers a message with Server-Sent Events over a POST,
which `EventSource` cannot do, so the body is read off the fetch response directly.

`identity.ts` keeps the distinction the whole design rests on: a **thread id** minted here (which is what makes
a follow-up land in the same conversation rather than opening a new one) is not a claim about anybody, while a
Google ID token is — and only the daemon can check the second. A typed name travels as a nickname and is
labelled that way where the model can see it.

`challenge.ts` solves whichever bot check the config asked for. The built-in one is proof of work, computed on
the main thread in yielding batches rather than in a worker: a worker would need a `blob:` URL, which a host
page's Content-Security-Policy is entitled to forbid, and being unable to chat because of the site's own
security policy is a worse failure than a busy second.

## The request that answers "did it work?"

Every widget load fetches its config, so that one request is also the install probe: the daemon records which
origin asked and whether it was admitted (`webchat-installs.ts`). Without it the app could not tell a working
Doorbell nobody has written to from one whose snippet was never pasted — both are an automation with no runs —
and the likeliest setup mistake of all, listing `example.com` but not `www.example.com`, had no symptom except
a chat that never opened. The owner's install panel reads it back and offers to add the origin that was
turned away.

## Where to look next

The other half of this wire is `_apps/sandbox/src/webchat/` — five small modules beside the routes, covering
config resolution, identity, the bot check, the thread store and the install probes. The shared shapes live in
`@intentic/sandbox-contract`, which this package imports as types only, so no schema library reaches a
visitor's browser.
