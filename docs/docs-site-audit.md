# Documentation audit — intentic.dev/docs

Read every documentation page as a visitor would: in a browser, on a desktop and a phone, following the
navigation, using the search, and measuring the prose. 21 pages, 28,997 words, about 2 hours 12 minutes of
reading end to end.

> **Status: the nine-item work order at the foot of this document has been carried out.** The findings below are
> left as written, as the record of what was wrong; each row of the work order now carries its outcome, and
> "After" at the very end has the re-measured numbers. Two pages were added (Glossary, Troubleshooting), so the
> site is 23 pages now.

---

## Verdict

The writing is genuinely good — better than most product documentation. It has a voice, it explains *why*
rather than only *what*, it is honest about limits, and the four-shelf structure sorts pages by who is reading
rather than by lifecycle stage, which is the harder and better choice. Nothing is dead: every link and every
in-page anchor resolves.

Three things hold it back, in order of damage:

1. **Two reference pages are visually broken.** Most of the HTTP API page and the tail of the manifest
   reference render in monospace — headings, paragraphs and tables all set as if they were code.
2. **Search cannot see the tables.** 90 of 235 table rows across the docs are missing from the index, and the
   tables are exactly what people search for. Some searches return a fragment of source code instead.
3. **The prose is written to be admired, not scanned.** One sentence in five carries an em-dash aside, one in
   four a mid-sentence colon, and one in five runs past 30 words. It reads beautifully at 100% attention and
   poorly at the 20% a reader actually brings when something is broken.

Everything below is ordered by how much reader damage it does.

---

## P0 — Broken

### 1. Two-thirds of the HTTP API page renders as code

On **HTTP API**, everything from *The shape of a call* to the end of the page — 8 of the 10 sections, 77% of
the page's height — sits inside a code element. Headings, body text and tables are all rendered in the
monospace face; the last four sections are additionally rendered on the dark code background at 12.9px. The
section labelled *Failures* looks like a terminal dump.

**Manifest reference** has the same fault over its last 26% — the final four sections, from
`contributes.processes` to *When each contribution takes effect*.

These are the two longest reference pages on the site (13 and 10 minutes of reading) and the two that people
arrive at from search with a specific question. They are the worst two pages to have this happen on.

*Trigger:* a code snippet inside a table cell whose content is a template placeholder rather than literal text.
When that appears in a table, everything after that table to the end of the page is wrapped as code. Confirmed
by reducing it to a minimal test page: the same snippet outside a table is fine, and a placeholder in a table
cell without the code formatting is fine. Only the combination breaks. Two pages use the pattern, and those are
exactly the two broken pages.

*Also:* both pages' published plain-text mirrors — the ones the machine-readable index points at — collapse at
the same point. The HTTP API mirror ends up with 3 of its 10 headings and a single 7,971-character line.

### 2. Search cannot find what is in the tables

The docs search reads the pages' authoring source rather than the finished page, so any table built from a list
is invisible to it. Measured: **90 of 235 table rows are unsearchable.** Among them —

| What a reader searches for | Where it lives | Found? |
| --- | --- | --- |
| `Maintainer`, `Collaborator`, `Viewer` — what each tier can do | Access & sharing, the tiers table | the row text: no |
| `Grok`, `Kimi Code`, `SuperGrok` — which providers are supported | Models & accounts, the provider table | no |
| `Sentry`, `SigNoz`, `Redmine`, `Komodo` — is my tool supported | Capabilities, the catalog table | no |
| `cron expression` — how do I schedule one | Automations, the trigger table | no |
| `Attention` / `Active` / `Finished` — what the board lanes mean | Parallel agents, the lane table | no |
| `views`, `viewers`, `commands` — what can an extension add | Extensions, the contribution tables | no |
| The section-jump tables at the top of HTTP API and Manifest reference | both pages | no |

The catalog of supported integrations — the single most-searched thing in any docs set — is 14 of its 16 rows
invisible.

### 3. Search results show source code to readers

18 raw template expressions leak into search snippets across 16 sections on 12 of the 21 pages. A reader
searching today can be shown `{ roles.map((role) => ()) }` or `{ categories.map((category) => ()) }` as the
preview of a result. It appears on Overview, Architecture, Access & sharing, Your own machine, Parallel agents,
Capabilities, Automations, Models, Reference architecture, Extensions, HTTP API and Host API.

---

## P1 — Navigation

### 4. The sidebar runs off the screen with no sign that it does

The docs rail lists all 21 pages plus 6 group headings — 27 rows, always fully expanded. On a 1366×768 laptop,
266px of it is below the fold *inside its own scroll area*, with no fade, no shadow and no scrollbar until you
hover. The whole **Build on it** shelf — extensions, the manifest, publishing, both API references — is
invisible to a reader on a standard laptop who does not think to scroll a list that looks complete.

The tree also never collapses: reading the quickstart, you carry the full contents of three shelves you are not
in.

### 5. Five pages are called one thing in the menu and another on the page

| Menu says | Page says |
| --- | --- |
| Updates & rollback | Updates: what we promise never breaks |
| Automations & workflows | Automations, workflows & loops |
| Autonomous employees | Turn sandboxes into autonomous employees |
| Publish & marketplace | Publish & the marketplace |
| Overview | intentic documentation |

The Automations one costs the most: the nav row never mentions loops, so a reader looking for "run this until
it's green" has no reason to open it.

### 6. Seven pages hide content above the first heading

On Automations, Capabilities, Docker setup, Models, Parallel agents, Host API and Your own machine, between 29
and 92 words sit after the "On this page" box and before the first section — so they are in no table of
contents, have no anchor, and cannot be linked to.

The worst case is Automations, where the orphaned block is the table distinguishing an automation from a
workflow from a loop: 92 words, the most important paragraph on the page, and the one the page's own opening
line promises ("They get mistaken for each other, so the distinction first").

### 7. Two different tables of contents

Nineteen pages get an automatic "On this page" list. Two — HTTP API and Manifest reference — carry a
hand-written index table instead and suppress the automatic one. Both are good; having both teaches the reader
that the pattern is unreliable, and the hand-written ones are the pages where the automatic list would be most
useful in the sticky rail.

### 8. "Next" is a section on 8 pages, absent on 12

Eight pages end with a `## Next` list, one with `## Where to go next`, twelve with nothing — and every page
already has an automatic previous/next footer underneath. On the eight, "Next" also takes a row in the section
rail, where it is the one entry that describes no content.

---

## P2 — Order

### 9. The quickstart's numbering stops at 2

The page runs: *What you need* → *1 · Sign in and get your setup code* → *2 · Pick how you install it* → four
unnumbered *Install with…* sections → *What comes up on your machine* → *After it's running*. Nine top-level
sections, two of them numbered. A reader who has done step 2 looks for step 3 and finds four peers of steps 1
and 2 instead. The four install routes are alternatives *inside* a step, and they should read as one.

### 10. The quickstart front-loads reference material

Step 1 is four paragraphs and a table — roughly 450 words on setup codes: how they are minted, that they expire
in 30 minutes, what happens on re-run, how to email yourself the link, what to do if you are building the
command by hand. All true, all worth having, none of it needed before the first install. The reader's own
answer to "how do I start" arrives about 900 words in.

### 11. Words are used shelves before they are defined

- **daemon** — 92 uses across 14 pages, and never defined anywhere. First appearance is on Architecture,
  already load-bearing ("the sandbox... exposes its daemon over its own Cloudflare tunnel").
- **land / landing** — first used on *Your own machine* and *Access & sharing* (Run a sandbox shelf); defined
  on *Parallel agents*, a shelf later.
- **worktree** — first used on Docker setup; defined on Parallel agents.
- **harness** — used on Automations; defined on Models, the next page.
- **fleet**, **slug**, **overlay**, **control token**, **chore**, **guard** — each introduced in passing on
  whichever page needed it first.

There is no glossary; "glossary" returns nothing.

### 12. Two pages say the same thing twice

*Automations › Who serves the wake* and *Models › Several accounts of one provider* make the same argument in
nearly the same words — an account running out of headroom, an organisation switching a plan off, every
unattended run erroring until someone reads the row. Eight shared seven-word runs. One of them should be the
canonical version and the other a link.

The reassurance that the platform holds only your identity and your sandbox's address appears on six pages.
That repetition is defensible — it is the trust claim — but it is worth being deliberate about.

### 13. The overview alternates concept and action

Its order is: the mental model → get one running → what's in a sandbox → find your way. The third section is
conceptual and sits after the install table, so a reader following the page top to bottom is sent off to the
quickstart and then asked to come back for the concept. *What's in a sandbox* belongs with *the mental model*.

---

## P2 — Wording

The house style is essayistic: an assertion, then a dash, then the reason it is true. It is excellent writing
and it is measurably heavy to scan.

| Measure | This site | Comfortable for docs |
| --- | --- | --- |
| Average sentence | 18.7 words | 15–20 ✅ |
| Sentences over 30 words | 19% | under 10% |
| Sentences over 40 words | 7% | under 3% |
| Sentences with an em-dash aside | 19% | — |
| Sentences with a mid-sentence colon | 26% | — |
| Sentences with a semicolon | 10% | — |
| Reading ease (Flesch) | 62 avg, 49–71 | 60–70 ✅ |
| Reading grade | 9.5 | 8–10 ✅ |

The averages are fine. The tail is the problem: nearly one sentence in five asks the reader to hold two ideas
at once. The heaviest pages are Automations (13 sentences over 30 words, 7 over 40), Publish & marketplace (17
over 30), Extensions (12 over 30, 6 over 40) and Parallel agents (12 over 30).

Worked examples:

> The moment your address is ready, the setup screen's *Run it* step shows you a finished command with the code
> already in it, behind a Copy button — one tab per install path, so the line you copy is the one your machine
> needs — *(Quickstart, step 1)*

> The choice is worth making because the loops genuinely differ in what they support, and the app tells you
> rather than letting you find out mid-turn: a runtime with no mid-turn steering, no clarifying questions, no
> per-tool approvals, no MCP tools or no reasoning-effort control has those limitations listed against it, and
> the composer hides the controls that runtime would ignore. *(Models, 61 words, 6 breaks)*

Two habits worth softening rather than removing:

- **Defining by contrast.** 10% of sentences say what something is *not* before saying what it is ("It is
  deliberately not a staged/unstaged view", "a status you set", "not a UI convention"). Each one asks the
  reader to build a wrong model and then discard it. Fine occasionally; at one sentence in ten it is a tax.
- **Headings that withhold.** *Living with them*, *Good to know*, *The deal*, *Money*, *The shape of it*,
  *Programs, not people*, *It is rebased before every turn*, *When it conflicts*. In the sticky section rail,
  stripped of their page, several of these say nothing about their content — and the rail is exactly where a
  returning reader looks.

---

## P3 — Gaps

- **No troubleshooting anywhere.** "troubleshoot" and "not working" return nothing. The only failure-mode
  writing in the whole set is inside the Doorbell page, where it is excellent ("This is the single commonest
  reason a freshly installed Doorbell stays silent…") and is the model the rest of the docs should copy.
- **Nothing about backups.** "backup" returns nothing, on a product whose central promise is that your files
  are yours and survive everything.
- **No cost page in the docs.** "pricing" returns nothing; the only money in the docs is the creator pool's
  $20 membership, written for extension authors rather than for users.
- **Architecture is thin for its position.** It is the second page a curious reader meets and the shortest page
  on the site (574 words), and about half of it restates the overview's two-tier model.

---

## What is working — keep it

- **The four shelves sorted by reader, not by lifecycle.** Understand / Run a sandbox / Drive agents / Build on
  it is the right cut, and the overview's framing of each as a question in the reader's own voice is the best
  page on the site.
- **No dead links.** Every internal link and every in-page anchor across all 21 pages resolves.
- **Search results name the section, not just the page.** A hit reads "Parallel agents › Landing automatically
  · Drive agents". That is the right unit and it is rare.
- **Breadcrumbs carry the shelf**, and previous/next moves within the shelf rather than through all 21 pages —
  so the docs never pretend to be a book you read front to back.
- **Mobile is properly considered**: the rail collapses, search sits beside the menu button rather than inside
  it, and the section list becomes an accordion.
- **The Doorbell page** is the best-structured page in the set: numbered steps, a check-that-it-worked step, the
  commonest failure called out where it happens, then the reference detail.
- **The honesty.** "Available today, and next", "What exists today, honestly", "Honest about the seams",
  "Trust, stated honestly". Very few products write this down.

---

## Suggested order of work

| # | Fix | Effort | Outcome |
| --- | --- | --- | --- |
| 1 | Un-break the HTTP API and manifest pages — move the placeholder snippets out of the table cells | small | Done, and differently: the placeholders stayed in their cells and became `<code set:text="…" />`. The trigger was narrowed to *an Astro expression inside a `<code>` inside a `<table>`*, which makes the compiler emit an unclosed `<code>`. `assertNoCodeBleed` now fails the build if any heading, paragraph or table renders inside a `<code>`. |
| 2 | Index the finished page rather than its source, so tables become searchable and no source leaks into a snippet | medium | Done. A `docsSearch` integration builds the index from the rendered pages in dist; under `astro dev` the `search.json` route asks the dev server for the same pages, so one extractor serves both. All 352 table rows indexed, no leaks. |
| 3 | Number the quickstart's install routes as one step, and move the setup-code reference detail out of step 1 | small | Done. The page is now 1 · Sign in → 2 · Pick how you install it (the four routes as `h3` inside it) → 3 · Check what came up. Step 1 is 247 words, was ~450; the contingency detail is an appendix, "More about setup codes". |
| 4 | Give the sidebar a visible scroll edge, or collapse shelves you are not in | small | Done, without collapsing (the component argues against it, for good reasons). A mask fades whichever edge has content behind it, the scrollbar is styled rather than overlay-only, and the rail scrolls the page you are on into view — so a Build-on-it page no longer opens a rail with no marked row in it. |
| 5 | Make the menu label and the page title agree on all five pages | small | Done. The rule is now written on `DocsLayout`'s `heading` prop: the h1 must start with the tree's `title`, with the descriptive form living in `meta.title` and the sentence in `lead`. The Automations row gained "loops" and still sets on one line. |
| 6 | Pull the seven orphaned intros under a real heading — starting with Automations | small | Done — all seven. The Automations distinction table is now "Automation, workflow or loop?", first in its own table of contents and linkable. The two reference pages that open with an index table are left alone on purpose. |
| 7 | Define *daemon*, *land*, *worktree*, *slug*, *harness* once, early, and link to them | medium | Done. A **Glossary** page on the first shelf, 23 terms in four families, each ending at the page that owns it. First uses of daemon, worktree, harness, landing and fleet link to it; chore, guard and slug were already defined where they first appear, so they were left. |
| 8 | Split the 69 sentences over 40 words; retire the "Next" sections that duplicate the footer | medium | Done. Zero prose sentences over 40 words. The ten `## Next` lists became a `DocsRelated` component — kept, because they are curated cross-links with reasons, but renamed "Related pages" (the automatic footer already says "next") and excluded from the section rail. |
| 9 | Add a troubleshooting page, modelled on the Doorbell page's failure-mode writing | medium | Done. **Troubleshooting**, last on "Run a sandbox": symptom as the heading in the reader's own words, then cause, fix, and where the product already says so. Every entry is a failure this product's own docs or run contract describe. |

Two P3 gaps were closed while nearby: **backups** now have a section on Docker setup (the honest version — they are
ordinary named volumes and there is no intentic backup service to describe), and **what intentic costs** now opens
the Models page's "What it costs", because a reader searching the docs for cost landed on a ledger of inference
spend with nothing saying the product itself is free.

The one item deliberately not attempted: **Architecture is thin for its position** (574 words, half of it restating
the overview). That is a writing commission rather than a fix, and it wants someone who can decide what the page is
*for* now that a Glossary sits beside it.

---

## After

Re-measured on the built site. Prose only — `<p>` and `<li>` inside the article, so tables, code blocks and
embedded diagrams are excluded, and a paragraph never runs into the code-block caption after it.

| Measure | Before | After |
| --- | --- | --- |
| Pages that render prose as code | 2 | 0 |
| Table rows missing from the search index | 90 of 235 | 0 of 352 |
| Sections leaking page source into previews | 16 | 0 |
| Pages whose menu label and h1 disagree | 5 | 0 |
| Pages with content above the first heading | 9 | 2, both by design |
| Pages with a rail entry that describes no content | 10 | 0 |
| Sentences over 40 words | 69 | 0 |
| Sentences over 30 words | 19% | 8% |
| Average sentence | 18.7 words | 13.9 words |
| Dead links and anchors | 0 | 0 of 763 |
| `troubleshoot`, `glossary`, `backup` | no results | all resolve |

Three of these are now build-time assertions rather than things to re-check by hand: a heading trapped inside a
`<code>`, a hand-written index table pointing at a heading that no longer exists, and — already there before this
work — the anchors on the two reference pages.

---

*Method: every page fetched from a running build and converted to plain text; readability measured over prose
only, with code blocks, tables and headings excluded; navigation checked at 1440×1000, 1366×768 and 390×844;
link and anchor integrity checked across the built site; the search index compared row by row against the
rendered pages.*
