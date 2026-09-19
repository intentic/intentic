# The desk edition: one reader, one product, across every handoff

How a person who does not write code meets intentic as one thing, from the first page of intentic.dev to the
workspace the desktop app opens, and what each part of the product carries so that no handoff drops them back
into the developer's version. This records the four handoffs, where each is carried, the one that was dropped and
how it is carried now, and what the site's `/desk` edition consists of.

[maker-audience-design.md](maker-audience-design.md) is the design of the maker's *screens* (the `audience`
preference, the vocabulary, the home, what steps aside). This document is about *arrival*: how a reader who was
sent to `/desk` ends up on those screens without ever being asked, whichever door they took.

## 1. The two audiences and the two names for the same thing

There are two words for "which product a reader is in", and they are deliberately different words for
different things:

- A **variant** is which design the *site* wears: the dark carved default, or `desk`, the light one. Decided in
  the browser before first paint from a path, a query or a cookie (`_site/site/src/lib/variant.ts`).
- A **profile** is who is *arriving* at the app, which the app answers in more than paint: a look (scheme and
  skin), an audience, and a sandbox seed (`@intentic/constants` `profile.ts`). `desk` seeds `light`, `none`,
  `maker` in the browser, and `desk.sandbox.toml` in the sandbox (auto-accept, versioning).

They share their names (`default`, `desk`), and `variant.ts` is the one place that maps one to the other.

The two states the owner asked for are consequences of the audience, not settings of their own:

- **"How you work: I don't"** is `ui-audience=maker`, seeded by the profile; `useAudience.chosen` reads a stored
  answer as answered, so the arrival card never asks.
- **"Hide technical files"** is `ui-workspace-hide-technical=auto`, which follows the audience
  (`shell/window/useLayout.ts`); a maker's tree hides tooling until a press records an override, and a maker who
  later says "I write code" gets it back without a second switch. Pinned by `useLayout.test.ts`. The profile
  deliberately does not write this key: an explicit `on` would outlive the audience changing.

## 2. The four handoffs

| Handoff | Carried by | Where |
| --- | --- | --- |
| site page → site page | the `variant` cookie, read by the pre-paint script on every page | `variant.ts` |
| site → app, same browser | `?profile=<variant>` added to every link into the app's origin at DOMContentLoaded | `variant.ts` `carry` |
| site → **installer** → desktop app → sign-in browser → app webview | the same cookie, set on the domain both origins share, read by the app's pre-paint script | `variant.ts`, `_editor/web/index.html` |
| app → sandbox | `arrivingProfile()` on the setup code / hosted provision; the platform hands the daemon a definition seed | `useProfile.ts`, `_platform/api/.../profiles.ts` |

The third row is the one that was dropped. A reader on `/desk` who pressed *Download for Windows* never clicked a
link into `app.intentic.dev`, so that origin's storage held no profile. The installer is a plain binary and
carries nothing. The app's webview has its own storage, and its sign-in opens in the reader's real browser
(Google refuses OAuth from a webview, `auth.rs`), where `DesktopAuth.vue` reads `arrivingProfile()` and hands it
to the app over `intentic://auth?…&profile=`. With nothing stored, the app opened as a developer: dark, git's
words, technical files listed, the arrival card asking a question the site had already answered.

### How it is carried now

The site's edition cookie is written with `Domain=intentic.dev` (`sharedCookieDomain` in `@intentic/constants`,
the registrable domain `intentic.dev` and `app.intentic.dev` share; none on localhost, where a host-only cookie
already crosses ports). The app's pre-paint script, with no `?profile=` on the URL, reads that cookie as the link
the reader would have followed: `desk` is the desk profile, any other value is the site's way out (the default
profile), no cookie is no opinion. The adoption rule is the link's own: a key the reader changed in Settings is
never overwritten, and leaving a profile releases only what it set. Pinned by `bootProfile.test.ts` ("arriving
with the site's cookie and no link").

So the first page on the app's origin the desktop app's reader meets, the sign-in page in their browser, adopts
the profile, forwards it to the webview, and the workspace opens as a maker, with the sandbox seeded as one. The
same fallback covers a reader who types the app's address later.

### Why the installer is not tagged

Tagging the installer (a `-desk` in the filename read back by NSIS `$EXEFILE` or the AppImage's `$APPIMAGE`, a
marker file, a second release asset, Rust plumbing to open the first workspace with `?profile=`) would carry the
profile through one more case: a sign-in browser that is not the download browser. It is brittle (download
managers rename files) and it would exist for that case alone. The webview's own first screen, the login page, is
drawn dark for everyone by design (`/login`'s plate), so nothing before sign-in can look wrong to either reader.

## 3. Two product pages, one shell

`/desk/` was the light skin's front door: the same landing page, relit, `noindex`. For a while after that it was
an *edition*, both readings of the page in one document and CSS showing one. That made the two products collapse
into one URL, and it put a second copy of the page's words into every cached document for search to weigh. It is
a **product page** now.

**`/` is the developer's page and `/desk/` is intentic desk's** (`DeskLanding.astro`, content in
`site-content/src/landing.ts` `deskLanding`). Each page's words are its own by URL, from the first line to the
last FAQ question, and neither carries a hidden copy of the other. `/desk/` is indexed, in the sitemap,
canonical to itself, with its own title, description, Open Graph image, FAQPage and a `SoftwareApplication` of
its own (`buildDeskAppSchema`, `isRelatedTo` the developer product's). The two cross-link: one line under each
hero ("Not a programmer?" / "Write code?") and the footer's two switches, so search reads two related products
rather than one page twice.

**What is shared** is the shell and the parts that are true of both products: the nav and footer (the nav takes a
`product`, which decides where its mark leads and whether its one action is the workspace or the download), the
frames and marks, the cost band's account list, the trust band, the closing cartouche. Never a paragraph of copy.

**What the cookie decides now is only the look of the shared pages.** A reader who came in through `/desk/`
reads docs, pricing and the feature pages in the light skin, with the nav's mark leading back to `/desk/` (a
runtime rewrite in `variant.ts`, since those pages are one cached document for both readers), and every link
into the app carrying `?profile=desk`. The words of the two product pages are never switched by it.

**The pictures** on `/desk/` are of the **desk recording**: a fourth demo mode (`_site/demo/src/mode.ts` `DESK`,
`fixture/desk.ts`), the same app on a workspace of documents rather than code. One person, a small studio, a
newsletter, a shop's website, letters and receipts; four conversations with plain titles; a finished draft whose
diff reads as tracked changes; the site's tooling counted as hidden rather than listed. Every seam that reads a
fixture picks the desk's when the mode says so. The mode is read in the desk profile's look (light, unskinned, a
maker), written before first paint by the demo's own `index.html` and taken back on the way out. The desk page's
*Open the live workspace* opens it (`/demo/agents?mode=desk`).

`_tools/e2e/shots/capture.mts --desk` shoots it: `desk-*` files in the light set alone, drawn by `DeskShot.astro`
as single images, since the desk page is only ever light. The developer page keeps `ProductShot`'s dark/light
pairs.

## 4. What this leaves open

- Only the landing pages are two products. The feature pages, docs, pricing and the download page are shared, in
  the desk skin for a desk reader, and their words are the developer's. The desk product's own sub-pages
  (`/desk/download/`, a desk features page) are the next step if the split proves out.
- The nav's menus are shared too: a desk reader sees Developers in the bar.
- The app's own words on a maker's screen are the maker design's business, not this document's, but two show on
  the desk recording's own shots: the *Ready to land* badge beside a maker's *Accept*, and *New agent* on the
  board (`agentStatus.ts` and the board read `t()` directly rather than the vocabulary).
- The desktop app's own faces (the setup card, the close question) know the profile's *light* (`auth.rs`
  `mode_of_profile`) and nothing else; their words are the same for both readers.
