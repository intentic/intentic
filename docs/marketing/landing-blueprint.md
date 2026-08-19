# intentic.dev — Landing page blueprint

The page that converts, section by section — selling **intentic-app** (app.intentic.dev). The one
thing sold (a persistent **sandbox** per co-piloted specialized agent, on hardware you own, with
any browser as a **window** onto it), the voice rules, the glossary, and the objection bank live in
[messaging.md](messaging.md); personas and pains (P1–P7) in [positioning.md](positioning.md).

**Core thesis (the spine):** you run a fleet of coding agents in parallel on hardware you own; the
runs keep going when you look away, and any browser — or a phone — reopens onto the same fleet; and
nothing reaches your tree until you have read the diff. Every section is a proof of that one sentence
or an objection to it. It is a **single page**: one continuous scroll, no variants.

**Why the spine changed (2026-08-02, do not quietly revert it).** The page used to argue *"everyone
else lets you edit the prompt; we let you edit the environment"*. That is a **reason to believe**, not
a promise — it only lands on a reader already deep in the agent-tooling debate, and it cost four
consecutive bands (`#contrast`, `#anatomy`, `#sandbox`, `#integrations`) restating one abstract point
at four altitudes. Around them sat five more "and also" bands — a Discord teammate, team sharing, a
whole company of agents, a website Front Desk. Fourteen sections, **16,254 px at 1440 wide, about
eighteen screens**, and the reported effect was exactly what that adds up to: *"individually all
interesting, together I lost track of what the product is."*

So the page now makes one claim and proves it, and the flexibility is **stated once** in a quiet band
near the bottom instead of demonstrated nine times. That band is also the honest framing —
`_extensions/README.md` calls the app *"a lean core + an extension system (the VSCode bet)"*, and
automations, Discord, Slack, IMAP, memory, pipelines and the Front Desk webchat really are things you
bolt on. Result: **9,592 px, five arguments and one index** — 10,298 px once `#trust` joined it.

**The environment argument did not die — it was demoted.** It rides in the FAQ's "How is this
different from a custom GPT", on `/features/review/` (the `prompt-vs-environment` figure) and
`/features/connect/` (the sandbox and its installed tools), and across `/compare/`. What it no longer
gets is four bands of the landing page.

**Re-centered 2026-08-07 (recorded decision).** The headline claim moved off the IDE frame and onto
what the infrastructure buys — persistence and reach — as the brand line
`Workstation for your agents. / A window for you.` (messaging.md's retired-framing list has the
line it replaced and the reason). This was a re-center, not a re-cut.

**Plain-worded 2026-08-12 (recorded decision, supersedes the 2026-08-07 brand line; its pronoun is in
turn superseded 2026-08-15, below).** The brand line became `You delegate. They work. / You approve.`
Both of the old nouns charged the reader a
translation — "workstation" reads as a desktop PC, and "a window for you" made the buyer a spectator
of a product whose whole stance is that the human approves the plan and reads every diff. The
claim itself did not move: the headline carries the stance and the subhead carries what it leaves
out. Nothing else on the page changed, and the retired-framing list in messaging.md holds the full
reason. (What the subhead carries changed later the same day — see the hero in the section list: it
is visibility now, not scale and persistence.)

**Said what it is 2026-08-15 (recorded decision, supersedes the pronoun and the subhead above).** The
brand line is now `You delegate. Agents work. / You approve.`, and the subhead leads with the
category: `A workspace for coding agents. Nothing happens out of sight.` The trigger was readers, not
taste: strangers who read the landing page, the About page, the docs and the demo still could not say
what the product was, and the model they built instead came off the nav's loudest words — that
intentic is a place to publish snippets for LLM agents. Two faults, one cause. `They` had no
antecedent anywhere above the fold, so the stance had no subject; and no line in the first screen
named the category, because every candidate had been ruled out for arguing a differentiator too early
(ownership answers a fear, persistence sells the reader's absence, scale was the crowded sentence).
Those rules were right about differentiators and wrong by omission about the category, which is not a
differentiator at all. The claim did not move and no band changed: the headline still carries the
stance, the subhead still carries visibility as its second beat, and the shot underneath is still the
proof. The page title and meta description were re-cut the same way, category first, because a search
result and a pasted link are the two places this product is met with no page around it.

**Plain words everywhere 2026-08-15 (recorded decision, same pass).** The hero was not the only band
running on slogans, so every section was rewritten to the simplest wording that is still accurate. The
standing rule, which the copy rules above now enforce section by section rather than only in the hero:
**no sentence may lean on a word the reader has not been given.** `#verbs` led with "Run a fleet. Stay
in control." over "Run them, wire them to your systems" — two abstractions and a pronoun, a second
screenful with nothing in it to hold; it now says "Run agents. Connect your tools. Read every change."
over "Each agent works in its own worktree, so many can run at once and they won't conflict." Card lines
lost their floating pronouns ("It plans first" became "The agent writes a plan"). `Host` said "hand off
the day-to-day" and now says what that is: move it to a server, invite your team.
`#economics` reads "intentic is free. Agents use AI plans you already pay for.", and its account list
carries each provider's own brand mark, drawn from `@intentic/constants` so the site and the app's
session labels cannot show different logos. `#connect` is "Three steps to your
first agent", and step ② is where **sandbox** is defined rather than assumed, because that is where a
reader meets the word first. The hero chip "Bring your own agent" became "Works with Claude, Codex and
Grok": the old one assumed the reader knew what an agent was and had one, which was the assumption the
whole first screen was making.

**The ownership ledger is retired 2026-08-15 (recorded decision, same pass).** The band headed "Your
code never leaves your machine" is gone, and `#workspace` has its slot. Three reasons. It answered a
fear the reader had not had yet, a whole screenful before the page asked for anything. Its heading was a
slogan with a qualifier underneath long enough to undo it (the hosted box lives on our provider's disk).
And its argument was already made in full by the trust band's first card, including that qualifier and a
link to the detail, so the page was making its safety case twice and its product case not at all. What
replaced it is the question the hero raises and the page never answered: you approve everything, so what
do you approve *with*. Ownership keeps the hero chip, the economics band, `#trust`, `/features/host/`,
`/privacy` and the FAQ. Do not re-add it as a band.

**Re-cut around the verbs 2026-08-09 (recorded decision, supersedes the loop/extend split).** The
middle of the page — the four-beat `#loop` and the six-row `#extend` bento — is now one band: a
five-verb tour (`#verbs`) in the same order as the Features menu (Orchestrate · Empower · Automate ·
Supervise · Delegate). The trigger was duplication — the same powers were told three times, in the
loop, in the extend bento, and in the menu — and it read as three tellings a visitor had to reconcile.
The tour tells them once, each verb one line and one screen, each linking to the page that proves it.
The core thesis, the ownership/economics/trust/connect objection bank and every guard below are
unchanged, and the page got shorter (~9,600 → ~8,000 px), not louder. The old loop's best proof is
kept where it belongs: the full board leads Orchestrate, the review diff is Supervise's card. The
sandbox "tools really installed" figure that rode in loop beat ② now lives only on the feature pages
(`/features/connect/`, `/features/host/`).

**Deliberately not on this page (all of it has a home).** The *detailed* product tour — each surface
with its own screens and figures — lives on `/features/*`; the home's `#verbs` band is a one-line-per-verb
summary that links there, never a second copy of it. Also off the page: the prompt-vs-environment
argument (`/features/review/`), the four-layer anatomy (same page), the integrations hub
(`/features/connect/`), the Discord teammate mock (same page), team sharing (`/features/host/`), the
workforce triptych and the company topology (`/docs/autonomous-employees/`, `/docs/reference-architecture/`),
and Front Desk (`/features/connect/`, `/docs/front-desk/`). Adding any of those back as a full band is a
regression, not an improvement — the `#verbs` tour carries the link instead.

**Deployment is not part of the product (do not re-add).** The monorepo happens to include a
deployment engine, but it is just one of the many tools an agent can run (like `psql`, a headless
browser, or `docker`). It is never a band, a card, a "superpower", a "sidecar", or an FAQ headline on
this page.

## Where the page lives

- Copy: `_site/site-content/src/landing.ts` — a single `LandingContent` object. Change copy there,
  not in the `.astro` files. There is **no `SITE_VARIANT`, no `/preview` route, and no a/b/c
  variants** — that system is retired.
- Structure: `_site/site/src/components/Landing.astro` renders the `LandingContent`;
  `_site/site/src/pages/index.astro` is the single entry.
- Meta: title/description come from `_site/site-content/src/page-meta.ts` /
  `_site/site-content/src/site.ts` (ORG_DESCRIPTION) — one page, one set of strings.
- Screenshots: `_site/site/src/assets/product/`, all written by one harness —
  `node --experimental-strip-types _tools/e2e/shots/capture.mts` after
  `pnpm --filter @intentic-dev/demo build`. It drives the DEMO build of the real app (the recorded
  "acme-shop" workspace the live demo runs on), so the site, the demo and the shots tell one story and a
  re-shoot needs no database, API or tunnel. Whole surfaces are captured; a page that wants a detail crops
  in CSS.
- Feature pages: `_site/site-content/src/product.ts` — a `productPages` array (five verbs) rendered by
  `_site/site/src/pages/features/[slug].astro`. Adding a verb there gives it a page, a nav row, a footer
  link, a card on `/features/`, page meta and an llms.txt entry.

## Conversion model

- **Primary conversion**: `Get started free` → app.intentic.dev (Google sign-in). Every scroll
  depth offers a path back to it.
- **Secondary**: `See the source` → github.com/intentic/intentic — the trust-through-transparency
  path. The sandbox + CLI that run on your machine are MIT; this is *not* framed as "the open-source
  engine" or a standalone deploy tool.
- Accuracy rules:
  - The `intentic.dev/connect` one-liner is **sandbox onboarding** shown in-product after sign-in.
    On the landing page it appears as *proof of setup speed*, always framed as step 3 of the
    wizard — never as a standalone "install intentic" instruction.
  - Requirements stated honestly wherever setup is shown: a machine with Docker (auto-installed
    with confirmation), Google account, **no Cloudflare account required**.
  - There are no tiers and no limits: every sandbox, capability and shared workspace is included,
    and nothing on the page may imply otherwise.
  - Every screenshot is real product UI. Re-shoot on UI shifts; never mock a screen the app doesn't render.

## Page architecture

One page, one continuous scroll — **the claim, a five-verb tour, two objection bands and a trust band**,
down from fourteen. Section ids in parens; copy per section in `landing.ts`, except `#trust`, whose copy
is in `about.ts` because `/about/` shares it.

1. **Hero (`#hero`)** — the brand line, kept verbatim ("You delegate. Agents work. You approve.")
   + the subhead `A workspace for coding agents. Nothing happens out of sight.` (recorded decision
   2026-08-15; its second beat is the 2026-08-12 decision, which replaced "Ten agents at once. They
   keep working after you close the browser."). The subhead's **first beat says what the product
   is** — nothing else above the fold did, and that is precisely what readers bounced on. The
   headline owns the stance and the second beat owns **visibility**: "You approve" is a gate at the
   end of a run, the subhead claims the whole of it — watched while it happens, interruptible
   mid-thought — and the board cropped underneath is the proof, on sight, in the same screenful. **Scale is now shown, not
   said**: the shot is a full board, and "ten agents at once" had become the most crowded sentence in
   the category, so it bought nothing a competitor wasn't also saying. **Persistence moved down** to
   the meta description, the final CTA and the FAQ: every phrasing of it above the fold sold the
   reader's *absence* ("close the browser", "come back to the diffs"), which argues against the
   co-piloted stance the headline sets one line earlier, and it is the trope every agent product
   is running at once. Ownership stays out of both lines for the standing reason (it answers a fear,
   it does not create a want). CTAs, chips, and **two windows** — the workspace behind, the chat in
   the window the product itself pops it out into, overlapping its bottom corner — with the play
   button into the live demo in the app window's top-right corner, which is the one band all three
   of its screens leave clear. (P1, P2, P6)

   **Both frames cycle** (recorded decision 2026-08-19), roughly every four seconds and on alternate
   beats, so the pair takes six steps to repeat rather than two. The lists are in `landing.ts`
   (`hero.screens`): the app window walks `/agents` → `/workspace` (Changes, grouped by repository,
   with a diff open) → `/pipelines`; the chat window walks its Agents cut → its Personas cut. Order
   is editorial and the FIRST of each is what a stranger sees — the board, and the conversation its
   cards lead to. Each frame **crops from the top-left** rather than fitting its screen, which is
   what lets captures of very different lengths share one frame and what keeps the app's own 13px
   type readable in a column this narrow.

   **`prefers-reduced-motion` changes the transition, not whether the frames turn.** It first skipped
   the rotation outright, and that was the wrong reading twice over: what the frames carry is content
   that exists nowhere else above the fold, so holding them still hid two thirds of the first screen
   rather than calming it — and on a machine with the setting on, the hero silently became a single
   screenshot with no sign it was meant to be more. The animation is the cross-fade, and that is what
   the preference turns off (`.hero-screen` in global.css cuts instead of fading). If the script never
   runs at all, the first screen of each frame stands.

   **The columns are uneven and the wide one is the picture** (2026-08-19). The hero was a 50/50 grid,
   which gave the copy 592px it does not use — the paragraphs are capped at their own measure well
   short of it — and gave the two windows the same 592px, which is where "the app is unreadable in the
   hero" came from. The copy now takes 26rem and the visual the rest, leaning out of the container on
   the widest screens to a 64px gutter at the window's edge. The brand line **wraps to three balanced
   lines** at that width rather than dropping to 30px to stay on two: `text-balance` puts the break on
   the full stop, so it reads as three short sentences. The buttons wrap to two rows, which is where
   the download belonged anyway.
2. **What you do — the five verbs (`#verbs`)** — the one telling of what the product does, in the
   same five verbs as the Features menu, so the home page and the feature pages read as one product.
   **Orchestrate** leads at full column width with the whole fleet board; **Empower**, **Automate**,
   **Supervise** and **Delegate** follow as a 2×2 grid of compact cards — each a cropped real screen
   over one line, the whole card a link to the page that proves it. **Automate carries no screenshot**:
   it shows the events it wakes on and the guard→fresh-session outcome, because no honest automations
   capture exists (same rule as its feature page). This one band replaced the old four-beat `#loop` and
   six-row `#extend` (see the 2026-08-09 decision above): the product's powers were told three times —
   the loop beats, the extend bento, and the menu — and once is enough. (P2, P4, P5, P6)
3. **Why a workspace (`#workspace`)** — the answer to the question the hero raises. The hero promises
   the reader approves everything, so this is where the page shows what they approve *with*: the diff,
   the editor and file tree, the agent's own terminal, the run as it happens. Made as a comparison
   against a chat box, two columns of nouns, because the asymmetry is the argument. Replaced the
   ownership ledger on 2026-08-15 (recorded decision above). (P1, P6)
4. **Economics (`#economics`)** — the deal, and the answer to the reflex that "ten agents" triggers:
   bring your own model subscription, run on your own hardware, pay us nothing — never a meter on model
   usage. Carries the free story. (P7)
5. **About the creator (`#trust`)** — the last objection before the command. The page has just asked a
   visitor to run a container on their own machine and hand it a GitHub token and a database password;
   its own first card answers the architectural half of *"can I trust this"* and is now the only place
   on the page that does, and the rest of the band answers the human half.
   Creator-forward: the name, the role, three profile chips, then four cards — *why trust intentic ·
   open source first · it builds itself · honest about its age*. Copy in `about.ts`, shared with
   `/about/` so the two cannot drift. (P1, P4)
6. **Get connected (`#connect`)** — the speed proof: ① Sign in with Google ② Your sandbox is waiting
   (made for you, and the step that defines the word) ③ Paste one command, with the real command block. Two of the three are things
   the visitor does not have to do, which is the point the band is making. (P3)
7. **FAQ (`#faq`)** — see below.
8. **Final CTA** — restate the claim + `Get started free` · `See the source`. (close)

### The trust band's rules (they are what keep it from backfiring)

- **Verifiability, not popularity.** No logo wall, no testimonials, no "trusted by N developers". The
  product is weeks old; the honest version of that is a *position*, and card four says so outright. A
  trust section that concedes nothing reads as marketing and takes the other three cards down with it.
- **No slot that can render a zero.** An empty social-proof counter costs more trust than it buys —
  `atlas-protocol.com/about/`, which this band's shape is adapted from, demonstrates it at its own foot
  with "0 TOTAL POPULATION · 0 RECENTLY ACTIVE". Do not add a metric that could be zero or one.
- **The commit numbers are measured, never typed.** `gitStats()` in `_site/astro-integrations` counts
  `agent@intentic.dev`-authored commits at build time — the number changes with every land, and it is
  the strongest asset on the site precisely because it is checkable: *the fleet on this page shipped
  the page*. It refuses shallow clones and falls back to the sentence without a figure rather than
  reporting "1 of 1".
- **Nothing that is not already public** on github.com/radarsu, linkedin.com/in/radarsu or radarsu.com.
- The contact address lives on `/about/` only, split into spans and assembled by script on first
  interaction, so no `\S+@\S+` exists in the served markup.

The objection bank from messaging.md renders as FAQ with FAQPage JSON-LD (kept in sync with
messaging.md, deployment kept out of it) — not a numbered marketing band above. It is rendered OPEN, in
topic bands (`faqGroups`), with a jump nav: thirteen collapsed rows hid every answer from both the reader
and in-page search.

The FAQ **survived the 2026-08-02 cut almost whole** (only "What are automations?" left, folded into
the `run-a-fleet` answer with a link to the guide that owns it). It is not part of what blurred the
page: a visitor self-selects into a band, the answers carry the arguments the bands no longer make, and
it is the page's only FAQPage-eligible content. Do not trim it for length.

## The feature pages (`/features/*`)

The landing page sells the claim; these pages show the product — and **they are named as VERBS, not
surfaces**, because the old surface names (Fleet board, Chat & plan mode, Review & land, the editor…)
read as table stakes any agentic editor has, and half the menu undersold the product. Five pages, in
menu order:

- **Orchestrate** — run the whole fleet, get pulled in only when one needs you (was Fleet board).
- **Empower** — wire agents into your systems and onto your own website (was Capabilities, Front Desk folded in).
- **Automate** — agents that wake on an event under permissions you set (NEW — this had no page before).
- **Supervise** — plan, approve, review every diff, curate the context (was Chat & plan mode + Review & land + the shared editor).
- **Delegate** — give the sandbox a server of its own and hand off operation (was Sandbox & ownership).

**Recorded decision (2026-08-09): surfaces → verbs (do not quietly revert).** The shelf used to be seven
surface pages grouped run / environment / extend; those noun names filed us next to ordinary editors and
buried the differentiators. The `page.group` field is gone — the menu and the `/features/` index are one
flat ordered list of verbs, and each verb folds the relevant surfaces underneath it as proof.

**Two positioning guards baked into the cut:**

- **Delegate is not a deploy product.** It is about running the *sandbox itself* on a server you own and
  letting it operate autonomously — ownership + autonomy. The deployment engine is still never a pillar
  (see messaging.md); Delegate never means "ship your app with our deployer", and ownership leads the page
  so the moat stays legible.
- **Front Desk folded into Empower, not deleted.** A website chat widget is one thing you empower an agent to
  do, not a product of its own — it is a block on `/features/connect/`, and `/docs/front-desk/` still owns the
  deep guide.

Rules that keep them honest:

- **Screenshot-first, with one sanctioned exception.** Each block leads with a real screen and follows
  with ≤60 words. Where a surface has no honest screenshot (isolation, the platform boundary), the block
  carries a DIAGRAM (`ProductFigure.astro`) — never a mockup. **Automate is diagram-led**: there is no
  captured automations screen, so its hero is the `triggers` figure and its index card is a mini-diagram.
  If an automations/personas screen becomes capturable, give it a real hero and demote the figure to a block.
- **No invented numbers.** The facts strip under each hero carries only things that are true by
  construction (three lanes, one branch per agent, two fields stored by the platform, 25 catalog
  entries). The repo has no benchmark worth quoting yet: the offline cleaner bench measures ~2% over a
  real corpus, and the agent A/B bench costs real tokens to run. When one exists, it gets a page of its
  own rather than a number in a hero.
- The demo fixture (`_editor/web/src/demo/`) is the world every shot is taken in, so enriching it improves
  the public demo and the marketing shots in the same commit.

## The comparison shelf (`/compare/*`)

The second content-driven shelf, and it works the same way: `_site/site-content/src/compare.ts` holds the
five families plus one `ComparePage` per competitor, and `_site/site/src/pages/compare/` renders them with
one hub and one template. Positioning and the rules that keep it honest live in
[positioning.md](positioning.md#competitive-frame); do not re-argue them here.

What is a *layout* decision rather than a positioning one:

- **The hub leads with a jump strip, not an argument.** A visitor arrives wanting to find their tool and
  leave; every page is linkable inside the first viewport, before the two-questions band and before the
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

No standalone pricing block and no "Pricing" nav/footer link — there is nothing to price. The free
story is carried softly: the hero "Free and open source" chip, the economics band, the final CTA, and
the FAQ answer "Is any of it paid?". The `SoftwareApplication` JSON-LD `offers` price "0" reinforces
free for SEO.
Note for any auto-improver (`loop.md`): **do not** reintroduce a pricing section, and **do not**
re-add deployment-engine framing — the deployment engine is not part of the product. Both are
recorded decisions, not omissions.

### No new bands (deliberate — the 2026-08-02 cut)

The third recorded no, and the easiest one to undo by accident. **A capability that deserves attention
belongs on the relevant verb's `/features/*` page and, at most, its verb's line in `#verbs`; it does not
get a band of its own.** Before adding a section, check whether the thing already has a `/features/*` or
`/docs/*` page: if it does, the honest move is a link. Fourteen bands is what cost this page its meaning.

**The one carve-out, and its boundary.** `#trust` was added later the same day and is not a breach of
the rule above — the rule governs *capability* creep, and trust is not a capability. A visitor who does
not believe you never reaches the curl command at all, so the band is conversion-critical rather than a
nice-to-have, and it answers a question the page provably was not answering: the founder existed only
in the JSON-LD, told to Google and never to the reader. That is the shape of a legitimate exception —
**an unanswered objection on the path to the CTA, not a feature that wants more room.** A feature never
qualifies. If a future band cannot be described as "the reader will not act until this is answered",
it belongs on a `/features/*` page the `#verbs` tour links to, not on a band of its own.

## Conversion checklist

- [ ] `Get started free` resolves to a working app.intentic.dev sign-in.
- [ ] `See the source` resolves to github.com/intentic/intentic.
- [ ] Every section ends within one viewport of a CTA.
- [ ] The page is still one claim. Read it cold and answer "what is this product?" in one sentence.
- [ ] `#trust` still concedes something, and still shows no number that could be zero.
- [ ] The `#trust` commit figures came from git, not from a paste — check a real `astro build`, not dev.
- [ ] Full-page height at 1440 has not crept back over ~10,000 px (it was 16,254, then 9,592; it is
  ~8,000 after the 2026-08-09 verb re-cut).
- [ ] Nothing on the page implies a paid tier, a limit or a price.
- [ ] Every screenshot is real product UI (`_site/site/src/assets/product/`); re-shoot on UI shifts.
- [ ] `prefers-reduced-motion` respected (`.fade-in` noscript fallback — keep).
- [ ] Lighthouse ≥ 95 perf/SEO/a11y on `/` (static Astro + inlined CSS baseline — keep).
- [ ] Follow-up asset (not launch-blocking): 30–60s screen capture — an agent given a job, its plan
  approved, a diff reviewed and committed.

## Brand note (decision recorded)

The design system's signal color is orange `#d8531c`; keep the cut-metal orange system. The hero
visual and product screenshots must not clash with the page around them.
