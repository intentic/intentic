# intentic.dev — Landing page blueprint

The page that converts, section by section — selling **intentic-app** (app.intentic.dev). The one
thing sold (co-piloted **specialized agents** — autonomous employees on hardware you own), the voice
rules, the glossary, and the objection bank live in [messaging.md](messaging.md); personas and pains
(P1–P7) in [positioning.md](positioning.md).

**Core thesis (the spine):** you run a fleet of coding agents in parallel, on hardware you own, and
nothing reaches your tree until you have read the diff. Every section is a proof of that one sentence
or an objection to it. It is a **single page**: one continuous scroll, no variants.

**Why the spine changed (2026-08-02, do not quietly revert it).** The page used to argue *"everyone
else lets you edit the prompt; we let you edit the environment"*. That is a **reason to believe**, not
a promise — it only lands on a reader already deep in the agent-tooling debate, and it cost four
consecutive bands (`#contrast`, `#anatomy`, `#sandbox`, `#integrations`) restating one abstract point
at four altitudes. Around them sat five more "and also" bands — a Discord teammate, team sharing, a
whole company of agents, a website Doorbell. Fourteen sections, **16,254 px at 1440 wide, about
eighteen screens**, and the reported effect was exactly what that adds up to: *"individually all
interesting, together I lost track of what the product is."*

So the page now makes one claim and proves it, and the flexibility is **stated once** in a quiet band
near the bottom instead of demonstrated nine times. That band is also the honest framing —
`_extensions/README.md` calls the app *"a lean core + an extension system (the VSCode bet)"*, and
automations, Discord, Slack, IMAP, memory, pipelines and the Doorbell webchat really are things you
bolt on. Result: **9,592 px, five arguments and one index**.

**The environment argument did not die — it was demoted.** It rides in the hero subhead ("the job's
dev-tools really installed, wired to your systems"), in loop beat 02's sandbox figure, in the FAQ's
"How is this different from a custom GPT", on `/product/sandbox/` (the `prompt-vs-environment` figure),
and across `/compare/`. What it no longer gets is four bands of the landing page.

**Deliberately not on this page (all of it has a home).** The seven-card product-tour grid (the nav
mega-menu and `/product/` already list every surface), the prompt-vs-environment argument
(`/product/sandbox/`), the four-layer anatomy (same page), the integrations hub (`/product/capabilities/`),
the Discord teammate mock (same page), team sharing (`/product/sandbox/`), the workforce triptych and
the company topology (`/docs/autonomous-employees/`, `/docs/reference-architecture/`), and Doorbell
(`/product/doorbell/`, `/docs/doorbell/`). Adding any of them back as a band is a regression, not an
improvement — the `#extend` band exists to carry the link instead.

**Deployment is not part of the product (do not re-add).** The monorepo happens to include a
deployment engine, but it is just one of the many tools an agent can run (like `psql`, a headless
browser, or `docker`). It is never a band, a card, a "superpower", a "sidecar", or an FAQ headline on
this page.

## Where the page lives

- Copy: `_libs/site-content/src/landing.ts` — a single `LandingContent` object. Change copy there,
  not in the `.astro` files. There is **no `SITE_VARIANT`, no `/preview` route, and no a/b/c
  variants** — that system is retired.
- Structure: `_apps/site/src/components/Landing.astro` renders the `LandingContent`;
  `_apps/site/src/pages/index.astro` is the single entry.
- Meta: title/description come from `_libs/site-content/src/page-meta.ts` /
  `_libs/site-content/src/site.ts` (ORG_DESCRIPTION) — one page, one set of strings.
- Screenshots: `_apps/site/public/assets/product/`, all written by one harness —
  `node --experimental-strip-types _tools/e2e/shots/capture.mts` after
  `pnpm --filter @intentic-dev/demo build`. It drives the DEMO build of the real app (the recorded
  "acme-shop" workspace the live demo runs on), so the site, the demo and the shots tell one story and a
  re-shoot needs no database, API or tunnel. Whole surfaces are captured; a page that wants a detail crops
  in CSS.
- Product pages: `_libs/site-content/src/product.ts` — a `productPages` array rendered by
  `_apps/site/src/pages/product/[slug].astro`. Adding a surface there gives it a page, a nav row, a footer
  link, page meta and an llms.txt entry.

## Conversion model

- **Primary conversion**: `Get started free` → app.intentic.dev (Google sign-in). Every scroll
  depth offers a path back to it.
- **Secondary**: `See the source` → gitlab.com/radarsu/intentic — the trust-through-transparency
  path. The sandbox + CLI that run on your machine are MIT; this is *not* framed as "the open-source
  engine" or a standalone deploy tool.
- Accuracy rules:
  - The `intentic.dev/connect` one-liner is **sandbox onboarding** shown in-product after sign-in.
    On the landing page it appears as *proof of setup speed*, always framed as step 3 of the
    wizard — never as a standalone "install intentic" instruction.
  - Requirements stated honestly wherever setup is shown: a machine with Docker (auto-installed
    with confirmation), Google account, **no Cloudflare account required**.
  - Free-tier limits come from `_apps/api/src/billing/entitlements.ts` (free: 1 sandbox, no
    sharing; pro: unlimited + sharing). **Never hardcode Stripe prices.**
  - Every screenshot is real product UI. Re-shoot on UI shifts; never mock a screen the app doesn't render.

## Page architecture

One page, one continuous scroll — **five arguments and one index**, down from fourteen bands. Section
ids in parens; copy per section in `landing.ts`.

1. **Hero (`#hero`)** — the brand line, kept verbatim ("An IDE for your agents. A window for you.") +
   a subhead that carries the whole claim: a sandbox of its own on hardware you own, the job's
   dev-tools really installed, its own git branch, one or ten in parallel, and the window — you watch
   the board, answer the ones that stop, read every diff before it lands. CTAs, chips, the real fleet
   board cropped to two lanes, and the play button into the live demo. (P1, P2)
2. **The loop (`#loop`)** — the spine, in three beats, and **the section that earns the headline's
   second half**: the window is the board you watch, the agent you answer, and the diff you read.
   ① *Give the work to as many agents as it needs* — the whole fleet board, full column width.
   ② *Each works in a sandbox of its own* — the container figure, because there is no honest screen of
   "its tools are really installed" and a mockup of one would be the first lie on the page.
   ③ *Nothing lands until you have read the diff* — the review panel, cropped. (P2, P4, P6)
   Layout follows the shot, as on the product pages: a capture wider than 3:2 takes the full column,
   anything squarer keeps the cropped side-by-side. The threshold is 3:2 and not merely landscape
   because `agent-review.png` is 2144×1800 — a tall panel a hair wider than high, which given the whole
   column is mostly the empty canvas under its own diff.
3. **Ownership (`#ownership`)** — the moat: browser → private tunnel → your machine, with the platform
   dashed and off-path. Code and keys never leave your machine; the platform keeps identity and a URL.
   Give it room — competitors can't copy this without re-architecting. (P1)
4. **Economics (`#economics`)** — the deal, and the answer to the reflex that "ten agents" triggers:
   bring your own model subscription, run on your own hardware, pay a flat platform fee — never a meter
   on model usage. Carries the free story. (P7)
5. **Extend it (`#extend`)** — *"A small core. Everything else is an extension."* Six one-line rows,
   each linking to the page that owns it: automations, Discord & Slack, Doorbell, team sharing,
   memory/pipelines/previews, a whole company of agents. **Deliberately the quietest band on the
   page** — no screenshots, no figures, no argument. Its job is to be findable, not persuasive; every
   row here used to be a band of its own, and together they were what made a visitor lose the thread.
   Keep it to one screen. (P5, P6, Pro)
6. **Get connected (`#connect`)** — the speed proof: ① Sign in with Google ② Name your sandbox
   ③ Paste one command, with the real command block. (P3)
7. **FAQ (`#faq`)** — see below.
8. **Final CTA** — restate the claim + `Get started free` · `See the source`. (close)

The objection bank from messaging.md renders as FAQ with FAQPage JSON-LD (kept in sync with
messaging.md, deployment kept out of it) — not a numbered marketing band above. It is rendered OPEN, in
topic bands (`faqGroups`), with a jump nav: thirteen collapsed rows hid every answer from both the reader
and in-page search.

The FAQ **survived the 2026-08-02 cut almost whole** (only "What are automations?" left, folded into
the `run-a-fleet` answer with a link to the guide that owns it). It is not part of what blurred the
page: a visitor self-selects into a band, the answers carry the arguments the bands no longer make, and
it is the page's only FAQPage-eligible content. Do not trim it for length.

## The product pages (`/product/*`)

The landing page sells the claim; these seven pages show the product, one surface each — **Fleet board,
Chat & plan mode, Review & land** (the `run` group), **Workspace & editor, Capabilities, Sandbox &
ownership** (the `environment` group), and **Doorbell** (the `extend` group). They exist because the nav
used to be five anchors into this page: nothing linkable, nothing rankable, and no room for more than a
paragraph per surface.

**The `extend` group is a positioning decision, not alphabetising.** Doorbell headed the "Run agents"
column and the landing's card grid, which read as a claim that a website chat widget is what this
product is for — a different buyer from the one who wants a fleet of coding agents. It now sits in a
third mega-menu column beside the extension gallery, and `page.group` drives both the menu and the
footer order.

Rules that keep them honest:

- **Screenshot-first.** Each block leads with a real screen and follows with ≤60 words. Where a surface
  has no honest screenshot (isolation, event triggers, the platform boundary), the block carries a
  DIAGRAM (`ProductFigure.astro`) — never a mockup of a screen the app does not render.
- **No invented numbers.** The facts strip under each hero carries only things that are true by
  construction (three lanes, one branch per agent, two fields stored by the platform, 25 catalog
  entries). The repo has no benchmark worth quoting yet: the offline cleaner bench measures ~2% over a
  real corpus, and the agent A/B bench costs real tokens to run. When one exists, it gets a page of its
  own rather than a number in a hero.
- The demo fixture (`_apps/web/src/demo/`) is the world every shot is taken in, so enriching it improves
  the public demo and the marketing shots in the same commit.

## The comparison shelf (`/compare/*`)

The second content-driven shelf, and it works the same way: `_libs/site-content/src/compare.ts` holds the
four families plus one `ComparePage` per competitor, and `_apps/site/src/pages/compare/` renders them with
one hub and one template. Positioning and the rules that keep it honest live in
[positioning.md](positioning.md#competitive-frame); do not re-argue them here.

What is a *layout* decision rather than a positioning one:

- **The hub leads with a jump strip, not an argument.** A visitor arrives wanting to find their tool and
  leave; the six pages are linkable inside the first viewport, before the two-questions band and before the
  families. The families sit last because their job is to answer for the tools that will never have a page.
- **Nav is a bare top-level link, not a third mega-menu.** A menu of six competitor rows hands a visitor the
  names without the sorting, and the sorting is the part that changes their mind.
- **The verdict comes before the table.** A reader who stops after "The short answer" has still been told the
  truth; a reader who only scans the table sees the marked rows. Overlap before differences, `pickThem` last
  and at full weight.
- **The table is a real `<table>` that restacks under 48rem** — `data-side` carries the column header down
  into the stacked view, because a three-column table of sentences at 380px is one word per line.
- No screenshots on these pages. They compare products, not surfaces; the product shelf is one click away and
  is where the UI argument is made.

### No dedicated pricing section (deliberate — do not re-add)

No standalone pricing block and no "Pricing" nav/footer link. The free-first story is carried
softly: the hero "Free plan" chip, the economics band, the final CTA, and the FAQ answer "What's
free and what's Pro?". The `SoftwareApplication` JSON-LD `offers` price "0" reinforces free for SEO.
Note for any auto-improver (`loop.md`): **do not** reintroduce a pricing section, and **do not**
re-add deployment-engine framing — the deployment engine is not part of the product. Both are
recorded decisions, not omissions.

### No new bands (deliberate — the 2026-08-02 cut)

The third recorded no, and the easiest one to undo by accident. A capability that deserves attention
gets a **row in `#extend`** and a page of its own; it does not get a band. The page is allowed five
arguments — the loop, ownership, economics, the extend index, and the setup proof — because fourteen
is what cost it its meaning. Before adding a section, check whether the thing already has a
`/product/*` or `/docs/*` page: if it does, the honest move is a link.

## Conversion checklist

- [ ] `Get started free` resolves to a working app.intentic.dev sign-in.
- [ ] `See the source` resolves to gitlab.com/radarsu/intentic.
- [ ] Every section ends within one viewport of a CTA.
- [ ] The page is still one claim. Read it cold and answer "what is this product?" in one sentence.
- [ ] Full-page height at 1440 has not crept back over ~10,000 px (it was 16,254; it is 9,592).
- [ ] Entitlement copy matches `_apps/api/src/billing/entitlements.ts` at build time; no dollar amounts on the page.
- [ ] Every screenshot is real product UI (`_apps/site/public/assets/product/`); re-shoot on UI shifts.
- [ ] `prefers-reduced-motion` respected (`.fade-in` noscript fallback — keep).
- [ ] Lighthouse ≥ 95 perf/SEO/a11y on `/` (static Astro + inlined CSS baseline — keep).
- [ ] Follow-up asset (not launch-blocking): 30–60s screen capture — an agent given a job, its plan
  approved, a diff reviewed and committed.

## Brand note (decision recorded)

The design system's signal color is orange `#d8531c`; keep the cut-metal orange system. The hero
visual and product screenshots must not clash with the page around them.
