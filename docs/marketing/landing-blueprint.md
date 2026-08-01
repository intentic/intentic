# intentic.dev — Landing page blueprint

The page that converts, section by section — selling **intentic-app** (app.intentic.dev). The one
thing sold (co-piloted **specialized agents** — autonomous employees on hardware you own), the voice
rules, the glossary, and the objection bank live in [messaging.md](messaging.md); personas and pains
(P1–P7) in [positioning.md](positioning.md).

**Core thesis (the spine):** intentic is a shared IDE for you and your agents — and everywhere else
the prompt is the only layer of an agent you can change. The page proves that one idea end to end —
show the real workspace, name the layers nobody else opens, break one agent down into them, wire it to
your systems, scale it to a workforce, and carry the ownership + co-piloting story throughout. It is a
**single page**: one continuous scroll, no variants.

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

One page, one continuous scroll. Section ids in parens; copy per section in `landing.ts`.

1. **Hero (`#hero`)** — the thesis in one line ("An IDE for your agents. A window for you.") + the subhead
   that carries the argument ("Everyone else lets you edit the prompt…") + CTAs + chips, with a visual
   of a specialized agent as a *configured worker*, not a chat window. States the one thing sold.
   (P1, P2)
2. **The product / tour (`#tour`)** — the fleet board in full, then the six product pages as cards.
   The UI is the credibility device — prove the workspace exists before claiming anything about it —
   and the depth lives on `/product/*` rather than being repeated here. (P2, P4)
3. **The difference (`#contrast`)** — the core argument: the prompt is the one layer everyone lets you
   edit, versus the layers intentic opens (image, capabilities, per-turn context). Lands on the honest
   line: you can't make the model smarter, you can make it better informed and better equipped. The band
   makes a sweeping claim about "everyone else", so it carries the link that owns it — `contrast.cta`
   into the comparison shelf, where those competitors are named. (P2)
4. **Anatomy (`#anatomy`)** — the four layers of that environment, each one openable in the workspace:
   the sandbox, the installed toolchain, the capabilities wiring, the curated context that loads every
   turn. (P2, P5)
5. **Inside a sandbox (`#sandbox`)** — what actually runs on your hardware: a container with the
   job's toolchain baked in and genuinely runnable, its context loaded on every turn. (P2, P1)
6. **Connected / integrations hub (`#integrations`)** — capabilities: how an agent is wired to your
   repos, databases, chat, monitoring, and payments — credentials staying inside the sandbox. (P5)
7. **Workforce (`#workforce`)** — one agent becomes many: a fleet of specialized agents (one per
   role/job), run and supervised from the fleet board; automations make them event-driven. (P6)
8. **In your tools / Discord teammate (`#teammate`)** — the agent isn't stuck behind a chat window:
   invite it into Discord and it reads and reports like a colleague, with receipts. (P6)
9. **Ownership (`#ownership`)** — the moat: browser → private tunnel → sandbox, with the platform
   dashed and off-path. Code and keys never leave your machine; the platform keeps only a URL.
   Give it room — competitors can't copy this without re-architecting. (P1)
10. **Shared safely (`#sharing`)** — teams on Pro: invite by email, daemon-enforced grants,
    revoke/leave always work. Sharing without surrendering custody. (P1, Pro)
11. **The whole picture / company (`#company`)** — zoom out: an entire company assembled from
    specialized agents — a fleet of role & team sandboxes, plus a small **shared-services** band
    (GitHub, Discord, Outline, Infisical). It teases the docs reference architecture, not a feature
    list. **No "provision & reconcile" deploy spine** — the shared services are ordinary accounts a
    team already uses, not a deployment story.
12. **Economics (`#economics`)** — the deal: bring your own model subscription, run on your own
    hardware, pay a flat platform fee — never a meter on model usage. Carries the free story. (P7)
13. **Get connected (`#connect`)** — the speed proof: ① Sign in with Google ② Name your sandbox
    ③ Paste one command, with the real command block. (P3)
14. **Final CTA** — restate the thesis + `Get started free` · `See the source`. (close)

The objection bank from messaging.md renders as FAQ with FAQPage JSON-LD (kept in sync with
messaging.md, deployment kept out of it) — not a numbered marketing band above. It is rendered OPEN, in
topic bands (`faqGroups`), with a jump nav: thirteen collapsed rows hid every answer from both the reader
and in-page search.

## The product pages (`/product/*`)

The landing page sells the thesis; these six pages show the product, one surface each — **Fleet board,
Chat & plan mode, Review & land, Workspace & editor, Capabilities, Sandbox & ownership**. They exist
because the nav used to be five anchors into this page: nothing linkable, nothing rankable, and no room
for more than a paragraph per surface.

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

## Conversion checklist

- [ ] `Get started free` resolves to a working app.intentic.dev sign-in.
- [ ] `See the source` resolves to gitlab.com/radarsu/intentic.
- [ ] Every section ends within one viewport of a CTA.
- [ ] Entitlement copy matches `_apps/api/src/billing/entitlements.ts` at build time; no dollar amounts on the page.
- [ ] Every screenshot is real product UI (`_apps/site/public/assets/product/`); re-shoot on UI shifts.
- [ ] `prefers-reduced-motion` respected (`.fade-in` noscript fallback — keep).
- [ ] Lighthouse ≥ 95 perf/SEO/a11y on `/` (static Astro + inlined CSS baseline — keep).
- [ ] Follow-up asset (not launch-blocking): 30–60s screen capture — an agent given a job, its plan
  approved, a diff reviewed and committed.

## Brand note (decision recorded)

The design system's signal color is orange `#d8531c`; keep the cut-metal orange system. The hero
visual and product screenshots must not clash with the page around them.
