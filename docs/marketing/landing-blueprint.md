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
- Screenshots: `_apps/site/public/assets/product/` (real product UI —
  `workspace.png`, `chat.png`, `agents-fleet.png`, `agent-review.png`, `sandbox.png`, `capabilities.png`).

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
2. **The product / tour (`#tour`)** — a tour of real product screenshots: the workspace, chat, the
   fleet board, and the co-piloting surfaces (plan mode, diff review). The UI is the credibility
   device — prove the workspace exists before claiming anything about it. (P2, P4)
3. **The difference (`#contrast`)** — the core argument: the prompt is the one layer everyone lets you
   edit, versus the layers intentic opens (image, capabilities, per-turn context). Lands on the honest
   line: you can't make the model smarter, you can make it better informed and better equipped. (P2)
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
messaging.md, deployment kept out of it) — not a numbered marketing band above.

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
