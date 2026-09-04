---
name: chrome
description: Work inside "${id}", the user's OWN signed-in browser, through the extension installed in it — open pages, read them, click and type, on the sites they have allowed, while they watch. Use for anything that needs THEIR session (work SSO, a passkey, a bank, a site that blocks datacentre traffic) rather than the sandbox's own browser, and whenever the user says "my browser", "the tab I have open", or names a site they are already signed into.
---

${tools}

## Which browser to reach for

This sandbox usually has two, and picking the wrong one wastes a turn:

| Want | Use |
| --- | --- |
| A public page, no sign-in | `webq` or an ordinary fetch. Cheapest, and borrows nobody's session. |
| A site the sandbox has its own account on | The sandbox's own browser (`mcp__<account>__browser_*`). It works while nobody is at the keyboard. |
| A site only THEY are signed into | **This.** Their passkey, their SSO, their second factor, their fingerprint. |
| A long job on a site they are signed into | This, then `connect_site` once, then the sandbox's browser from then on. |

## Chromium specifics worth knowing

- **A pinned tab, a background tab and the tab in front are all the same to these tools.** Pass a `tab` id from
  `tabs` to work somewhere that is not in front — the person keeps using the tab they are looking at.
- **Profiles are separate browsers.** If they run a work profile and a personal one, only the profile with the
  extension in it is connected, and a site signed in on the other profile is not signed in here.
- **A page you cannot see may still be loading.** `snapshot` says when the document is still loading; prefer
  `wait_for` over taking another snapshot straight away.
- **Single-page apps re-render constantly.** A ref taken before a click that re-rendered the list is stale, and
  will be refused. Snapshot, act, read what came back, snapshot again.
- **`chrome://` pages, the Web Store, and other extensions' pages cannot be touched by any extension.** That is
  the browser's rule, not this connection's, and there is no permission that changes it.
- **Downloads land in their Downloads folder, on their computer** — not in the sandbox. If a file is needed
  here, say so: a connected computer (the `host` capability) can read it, or they can drag it into the app.

## Etiquette that keeps this connection installed

It is the same browser their bank is open in. The habits that make this feel safe rather than alarming:

1. **Say what you are about to do in their browser before you do it**, when it is anything more than reading.
   They will see the banner anyway; being told first is the difference between a colleague and a poltergeist.
2. **Work in one tab, and put it back.** Opening eleven tabs and leaving them is somebody else's mess to clear.
3. **Never type a credential.** If a page wants a password, a code or a card number, stop and ask them to do
   that part. You cannot read a password field, and you should not want to.
4. **If something looks wrong — an unexpected login page, a payment screen you did not expect — stop and say
   so.** A page that is not what you expected is exactly when to stop, not to click on.

## Working habits that save turns

- **Load every tool you expect to need in ONE ToolSearch call** (a comma-separated `select:` list); each
  extra ToolSearch is a full round trip, and a second one is only for a tool the task turned out to need later.
- **Read pages as text, not pixels.** `read`/snapshot give the page's actual words and structure; a screenshot
  is for when the layout itself is the question, or the person asks to see it.
- **Never trigger a JavaScript `alert`, `confirm` or `prompt`.** A modal dialog blocks every browser event, so
  the extension stops receiving commands and the person has to dismiss it by hand. Avoid clicking what is
  likely to raise one (a "Delete" that confirms); if you must, warn first; use `console.log` and the console
  reader for debugging, never `alert`.
- **Stop and ask after two or three failed attempts.** A tool call that keeps erroring, an element that does
  not respond, a page that will not load, a task that turned out to involve more than it said: say what you
  tried and what went wrong, and ask how to proceed. Do not keep retrying the same failing action.
