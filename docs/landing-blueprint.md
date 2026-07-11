# intentic.dev — Landing page blueprint

The page that converts, section by section — selling **intentic-app** (app.intentic.dev).
Message IDs (M1–M10) come from [messaging.md](messaging.md); pain IDs (P1–P8) from
[positioning.md](positioning.md). "Recover" means restore from git history (`d5e7473` = richest
homepage, `43b99de` = + legal pages); the current `main` is a hello-world placeholder.

## Conversion model

- **Primary conversion**: `Get started free` → app.intentic.dev (Google sign-in). Every scroll
  depth offers a path back to it.
- **Secondary**: `See the open-source engine` → github.com/radarsu/intentic — the trust-through-
  transparency path; star ask lives in the trust band.
- **Tertiary**: docs (`/docs/`) for the engine/CLI audience — linked from the DevOps band and nav,
  never competing with the hero.
- Accuracy rules:
  - The `intentic.dev/connect` one-liner is **sandbox onboarding** shown in-product after sign-in.
    On the landing page it appears as *proof of setup speed* (section 2), always framed as step 3
    of the wizard — never as a standalone "install intentic" instruction.
  - Requirements stated honestly wherever setup is shown: a machine with Docker (auto-installed
    with confirmation), Google account, **no Cloudflare account required**.
  - Free-tier limits come from `intentic-app/_apps/api/src/entitlements.ts` (free: 1 sandbox, no
    sharing; pro: unlimited + sharing). **Never hardcode Stripe prices** — pricing is read live
    from Stripe in-app. There is no on-page pricing section (see the no-pricing decision below);
    the free-vs-Pro breakdown lives only in the FAQ.

## Page architecture

Narrative arc: what it is (act 1: workspace + speed), why you can trust it (act 2: ownership +
control), what it can do (act 3: capabilities, automations, DevOps), then close (trust → FAQ → CTA).

### 0. Nav — recover + edit
Fixed blurred header: logo, Docs, FAQ, GitHub, and `Get started free` as the orange CTA
(was GitHub; GitHub moves to a quiet link).

### 1. Hero — new
- M1: "Build software with intent." + the verbatim subhead. CTAs `Get started free` ·
  `See the open-source engine`. Footnote per messaging.md.
- Visual: the **workspace itself** — chat panel mid-plan-approval next to file tree/diff view
  (screenshot or faithful mock). The product UI is the credibility device now, not a CLI block.
- Serves P1/P2: one glance says "real workspace", one line says "you own it".

### 2. Onboarding — new (the speed proof)
- M2: "A few minutes to a live workspace." Three steps rendered as the actual wizard:
  ① Sign in with Google ② Name your sandbox ③ Paste one command — with the real command block and
  the wizard's own reassurances quoted: "No open ports, nothing deployed — just a reachable
  workspace", "Needs Docker — installed automatically if missing (you'll be asked first)".
- Sub-line: "No Cloudflare account required. Use intentic's domain, or bring your own." (P3)

### 3. Ownership — new (the money section)
- M3: "You own every line." Simple diagram: **browser → sandbox (your machine), direct over a
  private tunnel; platform off to the side, dashed — stores identity + URL only.**
- Three fact cards: "Your code never leaves your machine" · "Credentials stay inside your
  sandbox" · "The platform can't reach your daemon — even if breached". (P1)
- This is the section competitors can't copy without re-architecting. Give it room.

### 4. Agent in control — new
- M4: "Autonomy with a steering wheel." Show the four permission modes with plan mode highlighted
  ("Propose a plan and wait for your approval before running."), the review panel
  (diff → discard/commit), and the environment-approval flow in one row of three UI vignettes. (P4)

### 5. Capabilities — new
- M5: "Grow your sandbox." Logo grid straight from `CAPABILITY_CATALOG` categories: Platform
  (DevOps, monorepo) · Code & issues · Observability · Data · Communication · Business & docs ·
  Servers · Extend (MCP, plugins). Reuse in-app card descriptions; trust chip verbatim:
  "Credentials are stored securely inside your sandbox and never shown in Files." (P5)

### 6. Automations — new
- M6: "Your agent, on call." Recipe cards from `AUTOMATION_RECIPES`: GitHub push · Sentry alert ·
  Stripe payments · new email · Discord · cron. One line on guard commands and per-run
  transcripts. (P6)

### 7. DevOps band — compressed from the engine story
- M7: "Infrastructure as intent." The engine's best moment, in one band: 3-line intent
  (`i.have.host`, `i.have.cloudflare`, `i.want.app`) beside the 12-row `intentic plan` output
  (`intentic/README.md:63-76`) — "You declared 3 things. The engine derived 12." Chips: zero
  inbound ports · reconciles until state reads true · one-click services (Outline, SigNoz,
  Paperless-ngx, OpenProject, Invoice Ninja, Infisical). Links: engine docs + GitHub. (P7)

### No dedicated pricing section (deliberate — do not re-add)
- **Decision:** there is intentionally **no pricing section**, and no "Pricing" link in the nav or
  footer. Rationale: a monetization-forward page reads as "vibe-coded slop that wants money," when
  the truth is everything is free to explore and users upgrade later, in-app. Leading with pricing
  cards undercuts trust with the exact audience we want (professional devs evaluating on merit).
- The free-first story is carried **softly** instead: the hero "Free plan" chip, the final CTA
  "Free to start.", and the FAQ answer "What's free and what's Pro?" (free = one full sandbox;
  Pro = unlimited sandboxes + team sharing). That's discoverable for anyone who looks, without
  pushing the transaction. The `SoftwareApplication` JSON-LD `offers` price "0" reinforces free for
  SEO (invisible on-page).
- Note for the `loop.md` auto-improver: **do not** reintroduce a pricing section or nav/footer
  pricing links. Pricing lives in the FAQ and in-app (via the app's UpgradeDialog).

### 8. Trust band — new (replaces testimonials we don't have)
- M9: "Built to be unable to betray you." Verifiable signals only: off-command-path architecture ·
  AES-256-GCM secrets at rest · GDPR export & deletion · unprivileged sandbox · MIT engine on
  GitHub (100+ tests, real tunnel e2e; link known limitations verbatim,
  `intentic/README.md:194-198`). Star-on-GitHub ask lives here, after credibility is earned.

### 9. FAQ — recover shell, replace content
- Render the 12-item objection bank from messaging.md (supersedes the old 6-item `faq.ts`, which
  is engine-only and cites a since-shipped limitation). Keep FAQPage JSON-LD. This is where the
  free-vs-Pro answer lives (see the no-pricing-section decision above).

### 10. Final CTA — new copy, recovered band
- M10: "Build software with intent." / "One command from a live workspace. Free to start."
  CTAs `Get started free` · `See the engine`.

### 11. Footer — recover + edit
3-col footer from `d5e7473`; add app.intentic.dev, FAQ, and engine GitHub links (no Pricing link);
keep Terms/Privacy (already referenced by the app's clickwrap consent — keep URLs stable).

## Recover vs. new — inventory

| Recover from git (`d5e7473`/`43b99de`) | Build new |
|---|---|
| Design system (`global.css`: cut-metal chamfers, orange signal, tokens) | Sections 1–9, 11 content (app-first) |
| Nav, Footer, Breadcrumbs, DocsLayout, LegalDoc, CodeBlock components | Workspace hero visual (screenshot/mock) |
| Legal pages (`/privacy/`, `/terms/` — the app's TERMS_VERSION points at them; recover first) | Ownership diagram (browser→sandbox, hub off-path) |
| JSON-LD builders, OG-image generation, sitemap, IndexNow, git-lastmod | Syntax-highlighted intent snippet (Astro `<Code>` + warm Shiki theme) |
| `_libs/content` package shape (site.ts, nav.ts, page-meta.ts…) — restructure content app-first | FAQ content refresh (messaging.md bank) |
| Docs pages — keep as the engine/CLI track, re-verified against current README | |

## Conversion checklist (launch gate)

- [ ] `Get started free` resolves to a working app.intentic.dev sign-in (launch dependency — page ships with or after the app).
- [ ] Analytics: Cloudflare Web Analytics beacon in BaseLayout (zero-config, no cookie banner).
- [ ] Kill every "hello world": BaseLayout defaults, `manifest.json`, OG strings → messaging.md SEO strings.
- [ ] Restore JSON-LD (Organization, WebSite, FAQPage, SoftwareApplication) + per-page OG images + sitemap + IndexNow.
- [ ] Every section ends within one viewport of a CTA.
- [ ] Legal pages recovered and reachable — the app's consent flow links intentic.dev/terms/ and /privacy/.
- [ ] Entitlement copy matches `entitlements.ts` at build time; no dollar amounts on the page.
- [ ] Product screenshots current (workspace, plan approval, capabilities grid) — re-shoot when the app UI shifts.
- [ ] `prefers-reduced-motion` respected (old `.fade-in` already does — keep).
- [ ] Lighthouse ≥ 95 perf/SEO/a11y on `/` (static Astro + inlined CSS baseline — keep).
- [ ] Follow-up asset (not launch-blocking): 30–60s screen capture — chat asks for a deploy, plan approved, app live at a URL.

## Brand note (decision recorded)

The recovered design system's signal color is orange `#d8531c`; the logo/favicon are
purple/indigo + cyan. **Decision: keep the cut-metal orange system and re-tint the logo/favicon**
(one SVG + one PNG) rather than repaint every component. Check the app's own palette when
executing — the workspace screenshots in the hero must not clash with the page around them.
