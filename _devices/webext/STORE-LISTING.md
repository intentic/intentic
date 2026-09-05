# The Chrome Web Store listing, field by field

Everything the listing form asks for, written out so submitting is copying rather than composing. The
Developer Dashboard is the only place these can be entered; nothing here is read by any code.

Keep this file and the listing in step: a claim that lives only in the dashboard is one nobody reviews.

---

## Item name

```
Intentic — your agent, in your browser
```

## Summary (132 characters max, shown in search results)

```
Let your intentic sandbox work in this browser, on the sites you allow, while you watch every click.
```

## Category

**Developer Tools** — it is a companion to a developer product, not a browsing utility. (Secondary, if the
dashboard asks: *Workflow & Planning*.)

## Language

English (United Kingdom).

## Description

```
Intentic gives you a sandbox — a private box with your repository, your tools and an AI agent that works in
it. This extension lets that agent work in THIS browser: the one you are already signed into.

That is the whole point of it. Your sandbox has its own browser, and it is the right tool for most jobs — it
runs while nobody is at the keyboard. What it can never be is you: your passkey, your work SSO, your bank's
device check, the sites that refuse a datacentre address. This borrows your browser instead of copying its
profile or sign-ins. Page content from sites you allow still goes to your sandbox and the AI model you chose;
the sign-in itself moves only when you use the separate hand-over action and confirm it.

You are there while it works. Every action draws a line in the corner of the tab it happened in, and anything
that looks like paying, deleting or submitting a password asks you first, on the page.

WHAT IT CAN DO
• Read a page the way an agent needs to: every link, button and field, named
• Click, type, choose from dropdowns, scroll, wait for something to appear
• Work in a tab that is not the one in front, so you keep using the browser
• Take a screenshot of a tab, for the canvas apps and PDF viewers a page's structure says nothing about
• Hand one site's sign-in to your sandbox, with your confirmation, so a long job carries on after you close
  the laptop

WHAT IT CANNOT DO
• Touch a site you have not allowed. Sites are granted one at a time, by you, and revoked in Chrome's own
  settings. Your browser enforces that, not us — an extension cannot grant itself a site
• See the other tabs. Chrome withholds even the address of a tab you did not allow, and the extension shows
  that honestly rather than pretending
• Read what you type into a password field
• Keep working when you pause it. One click in the popup and every request is refused

HOW IT CONNECTS
The extension talks to your sandbox and to nothing else. There is no Intentic server in the path, no account
to create here, no analytics and no third-party code. You pair it once with a code from your sandbox, and it
holds one outbound connection while the browser is open.

You need an Intentic sandbox to use this: https://intentic.dev
```

## Privacy practices tab

**Single purpose**

```
Lets a user's own Intentic sandbox read and act on web pages in this browser, on the sites the user
explicitly allows, so an AI agent can carry out tasks the user asked for while the user watches.
```

**Permission justifications** (one field each — these are the sentences reviewers read)

| Permission | Justification |
| --- | --- |
| `scripting` | Reading a page and clicking in it is the extension's only function. Injection happens solely into origins the user granted at runtime; Chrome refuses anything else. |
| `storage` | Stores the sandbox pairing the user made, which sites they allowed and whether each is read-only, whether they have paused the agent, and a local log of recent actions shown in the popup. Nothing is stored remotely. |
| `alarms` | Reconnects the extension's single WebSocket after Chrome evicts the MV3 service worker. It runs no periodic task otherwise. |
| `cookies` | One user-initiated action: "hand this site's sign-in to my sandbox", so a long-running job continues after the browser closes. It requires a confirmation on the page every time, a switch that is off by default, and it sends the cookies only to the user's own sandbox. |
| `host permissions` (`*://*/*`, optional) | Requested per site at runtime, never at install. The user chooses each site in the extension's popup and revokes it in Chrome's settings. |
| Content script on `*://*.intentic.dev/*` | Receives a pairing code the user's own sandbox page offers, so the user does not have to copy and paste it. It reads nothing else on those pages. |

**Data usage disclosures** — the connector reads arbitrary user-approved pages, so disclose the sensitive
categories that page content may contain rather than pretending every allowed page is public prose:

- *Personally identifiable information*: **yes** — allowed pages may contain names, email addresses, account
  numbers or other identifiers; page content goes to the user's sandbox and configured AI provider.
- *Health information*: **yes** — only when the user allows and asks the agent to work on a page containing it.
- *Financial and payment information*: **yes** — same boundary; the extension can work on banking, billing or
  purchase pages the user explicitly allowed.
- *Location*: **yes** — allowed page content can contain an address or current/entered location.
- *Authentication information*: **yes** — only when the user explicitly hands one site's cookies to their own
  sandbox, behind an off-by-default switch and an in-page confirmation every time.
- *Personal communications*: **yes** — reading an allowed mail, chat or ticket page sends that content to the
  user's sandbox and configured AI provider.
- *Web history*: **yes** — the current URL/title and the URLs/titles of allowed tabs are sent so the agent can
  identify and work in the requested page; unallowed tabs remain unnamed.
- *Website content*: **yes** — text, element labels and optional screenshots from explicitly allowed pages.
- *User activity*: **yes** — a local rolling log records the agent's page actions and the popup displays it;
  typed text is represented only by its length and password values are excluded.
- Certifications: **not sold to third parties**, **used only for the single purpose above**, **not used for
  creditworthiness or lending**.

**Privacy policy URL**

```
https://intentic.dev/privacy
```

(The section titled *The browser extension* covers this item specifically. `_site/site-content/src/legal.ts`
is where it is edited.)

**Support / homepage URL**

```
https://intentic.dev/docs/your-browser
```

---

## Graphics

| Asset | Size | Status |
| --- | --- | --- |
| Store icon | 128×128 PNG | `static/icons/icon-128.png` — the product's own lotus, rendered from the shared lotus in `_site/site/src/components/ornaments.ts` (`pnpm --filter @intentic/webext icons`) |
| Screenshot 1 | 1280×800 | `assets/store/popup-1280x800.png` — the popup, paired, three sites allowed, one request waiting |
| Screenshot 2 | 1280×800 | Optional but worth it: a real page mid-action with the banner up. Only a live session can produce that one |
| Small promo tile | 440×280 | **Required and ready:** `assets/store/promo-440x280.png`, regenerated with `pnpm --filter @intentic/webext store-assets` |

The first screenshot is generated from this repository, so it can be retaken whenever the popup changes:

```sh
pnpm --filter @intentic/webext build
pnpm --filter @intentic/webext preview          # → dist/store-shot.html, exactly 1280×800
(cd _devices/webext/dist && python3 -m http.server 8791)
# capture http://127.0.0.1:8791/store-shot.html at a 1280×800 viewport
```

It renders the REAL popup in an iframe against a backdrop — not a mockup — which is how the invisible
primary buttons were found before anybody installed it.

## Distribution

**Public**, **Unlisted**, or **Trusted testers** for the first weeks. The V2 publisher preserves this dashboard
setting; it cannot widen the audience. After changing visibility, publish once in the dashboard before handing
updates back to the API.

Publishing after the first submission is automatic: see [PUBLISHING.md](PUBLISHING.md).
