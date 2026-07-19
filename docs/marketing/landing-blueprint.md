# intentic.dev — Landing page blueprint

The page that converts, section by section — selling **intentic-app** (app.intentic.dev). The
single use-case sold, the three copy variants, and the voice rules live in
[messaging.md](messaging.md); personas and pains (P1–P8) in [positioning.md](positioning.md).

**Core decision (the pivot):** the page sells one use-case — *your coding agent, running on your
own machine, driven from any browser* — presented clean and simple. The deployment engine is a
sidecar: one card in the "What's included" row plus a FAQ answer, never a band, never the hero.

## Where the page lives

- Copy: `_libs/site-content/src/landing.ts` — a `LandingContent` object per variant (`a`/`b`/`c`),
  one shared skeleton. Change copy there, not in `.astro` files.
- Structure: `_apps/site/src/components/Landing.astro` renders a `LandingContent`;
  `src/pages/index.astro` selects the variant.
- Selection: `SITE_VARIANT=a|b|c` (build/dev env, default `a`) picks what `/` renders. In
  `astro dev`, `/preview/a|b|c` serve all three with a floating switcher; those routes are not
  emitted by production builds.

## Conversion model

- **Primary conversion**: `Get started free` → app.intentic.dev (Google sign-in). Every scroll
  depth offers a path back to it.
- **Secondary**: `See the open-source engine` → github.com/radarsu/intentic — the
  trust-through-transparency path.
- Accuracy rules:
  - The `intentic.dev/connect` one-liner is **sandbox onboarding** shown in-product after sign-in.
    On the landing page it appears as *proof of setup speed*, always framed as step 3 of the
    wizard — never as a standalone "install intentic" instruction.
  - Requirements stated honestly wherever setup is shown: a machine with Docker (auto-installed
    with confirmation), Google account, **no Cloudflare account required**.
  - Free-tier limits come from `intentic-app/_apps/api/src/entitlements.ts` (free: 1 sandbox, no
    sharing; pro: unlimited + sharing). **Never hardcode Stripe prices.**

## Page architecture

One skeleton, eight sections (per-variant copy in landing.ts — see the skeleton table in
messaging.md):

1. **Hero (`#hero`)** — variant H1 + subhead + CTAs + chips; the workspace mock mid-plan-approval
   (variant-specific scenario). The product UI is the credibility device.
2. **Get connected (`#connect`)** — the speed proof: ① Sign in with Google ② Name your sandbox
   ③ Paste one command, with the real command block.
3. **Anywhere (`#anywhere`)** — the use-case in action: three moment cards
   (desk → phone → back to diffs). This is the section that *shows* the single use-case.
4. **Ownership (`#ownership`)** — the moat: browser → private tunnel → sandbox diagram with the
   platform dashed and off-path, plus three fact cards. Competitors can't copy this without
   re-architecting; give it room.
5. **Control (`#control`)** — plan mode highlighted among the four permission modes + the
   changes-review card (diff → discard/commit).
6. **Included (`#more`)** — capabilities · automations · deploys, one card each. This row is the
   entire on-page footprint of the engine story; engine vocabulary stays out of it.
7. **FAQ (`#faq`)** — the objection bank from messaging.md (shared across variants); FAQPage JSON-LD.
8. **Final CTA** — variant close + `Get started free` · `See the engine`.

### No dedicated pricing section (deliberate — do not re-add)

No pricing section, no "Pricing" nav/footer link. The free-first story is carried softly: the hero
"Free plan" chip, the final CTA, and the FAQ answer "What's free and what's Pro?". The
`SoftwareApplication` JSON-LD `offers` price "0" reinforces free for SEO. Note for the `loop.md`
auto-improver: **do not** reintroduce a pricing section, and **do not** reintroduce a DevOps/engine
band — the sidecar framing is a recorded decision, not an omission.

## Conversion checklist

- [ ] `Get started free` resolves to a working app.intentic.dev sign-in.
- [ ] Every section ends within one viewport of a CTA.
- [ ] Entitlement copy matches `entitlements.ts` at build time; no dollar amounts on the page.
- [ ] Replace the hero mock with a real product screenshot when the app UI settles — re-shoot on UI shifts.
- [ ] `prefers-reduced-motion` respected (`.fade-in` noscript fallback — keep).
- [ ] Lighthouse ≥ 95 perf/SEO/a11y on `/` (static Astro + inlined CSS baseline — keep).
- [ ] When a variant wins, fold its copy into the default and delete the losers — don't keep three forever.
- [ ] Follow-up asset (not launch-blocking): 30–60s screen capture — task handed over at a desk,
  plan approved from a phone, diff reviewed back at the desk.

## Brand note (decision recorded)

The design system's signal color is orange `#d8531c`; keep the cut-metal orange system. The
workspace mock in the hero must not clash with the page around it.
