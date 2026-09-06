# Pricing: what intentic sells, and what it should

A rethink of the price list, written 2026-09-06 from the source as it stands. The question asked: the site
prices credits, premium extensions and paid services; a membership also lifts the hosted sandbox's hour cap;
the product is free on your own machine. How should those be positioned, and should one go? The answer,
stated once here and argued below: **sell the machine, drop the credit economy.** Companion to
[positioning.md](../marketing/positioning.md) (the business-model paragraph) and [messaging.md](../marketing/messaging.md)
(the pricing page rule). It replaces the two services audits — the integration snowball and the admission
design — which were removed with the feature they described.

## 1. What is sold today

Every figure below is read from `_platform/api/src/config.ts` (`hosted` and `pool` blocks) and
`_site/site-content/src/pool.ts`; none is typed from memory.

| Product | What the buyer gets | What it costs us | State of supply and demand |
| --- | --- | --- | --- |
| **Your machine** (free, MIT) | Unlimited sandboxes, every capability, extension, automation, shared workspace | Nothing: the platform is an identity store off the command path | The product. Every persona in positioning.md self-hosts |
| **Hosted, free lane** | One sandbox on Fly (4 shared vCPU, 4 GB, 10 GB disk), 40 awake hours a month, sleeps after 20 idle minutes, machine deleted after 21 days unopened (warned at 14) | Compute while awake, disk while it exists | The zero-friction onboarding; the only rung that asks nothing of a device you own |
| **Membership, $20 a month** (Stripe) | (a) the hosted sandbox unmetered and never reclaimed; (b) 1,000 credits a day; (c) the right to install premium extensions (each install donates 200 credits to its author); (d) the right to run paid services (1 to 200 credits a run); (e) a creator pool: $5 taken off the top, 90% of the remaining $15 paid to creators in proportion to credits spent | The member's machine, plus whatever the pool pays out | Live registry: 7 extensions, **0 premium**. Services catalog: **one demo service, shipped off by default**. Members can spend credits on nothing |
| **Wallet** (x402, USDC) | The owner's own on-chain wallet, custody-held, for paying any x402 endpoint on the internet | Nothing: it is their money and no fee is taken | Not gated by membership (`premiumOf` is never called under `wallet/`). Not a price of ours at all |
| **Trial** | 12 messages a day on intentic's own Gemini free-tier key, before an AI account is connected | Effectively nothing (Google's free tier) | Onboarding, not a product |

The word "credits" names nothing a person buys. Credits are not purchasable, do not roll over and cannot be
topped up; they exist so the platform can split $15 among creators in proportion to use. One credit is worth
`(20 - 5) / (30 x 1000)` = **$0.0005**. From that: a premium install pays its author 9¢; the price band's
ceiling (200 credits) is a 10¢ run; the probation ceiling (25 credits) is a 1.25¢ run; an author with a hundred
member installs a month earns $9.

## 2. The numbers behind the hosted sandbox

Fly's published rates for the configured shape (`hosted.cpus` 4, `memoryMb` 4096, `volumeGb` 10): shared-cpu-4x
with 1 GB is $8.08 per 30 days and each further GB is $5, so the box is **$23.08 a month always on, $0.032 an
awake hour**. The volume is $0.15 per GB-month: **$1.50 a month whether awake or asleep**. Stopped machines
cost their rootfs only.

| Who | Awake hours a month | Our cost | Against the price |
| --- | --- | --- | --- |
| Free lane, tried once and abandoned | ~0 | $1.50 disk for up to 21 days, then $0 | An acquisition cost under $1.05 |
| Free lane, used to the cap | 40 | $1.28 + $1.50 = **$2.78** | The ceiling on what a free user can cost |
| Member, three hours a day | 90 | $2.88 + $1.50 = **$4.38** | The $5 `infraUsd` assumption holds here |
| Member, a working day | 240 | $7.68 + $1.50 = **$9.18** | Fine |
| Member, always on | 730 | $23.36 + $1.50 = **$24.86** | Under water on a $20 plan before Stripe's $0.88 |

Break-even for a member who spends no credits is about **550 awake hours** (18 a day). A member who also spends
every credit sends $13.50 to creators, and the platform's remainder ($5.62) covers about **130 awake hours**.
The product's pitch ("still running when you look away", automations that wake it on a schedule) is a pitch
for exactly the high-hours member, so the bundle is priced against its own best customer. Today this costs
nothing, because nobody can spend a credit; it is the shape of the model, not a bill, that is wrong.

## 3. What is wrong, in five findings

1. **The membership bundles two unrelated goods.** A machine (a real cost, proven willingness to pay, the
   category Codespaces, Fly and Railway price by the hour) and a creator economy (no supply, no way to price a
   service with real upstream cost, an audit of our own saying so). The pricing page has to explain the second
   before a reader can buy the first: infra off the top, 90% share, 20 credits to the cent, donations deduped
   monthly, a probation ceiling. That is five concepts for a $20 button.
2. **The site argues against its own price.** "No tiers, no limits, no card", "we never meter your tokens",
   "nothing an agent does needs it", and then "1,000 credits a day", which every reader parses as a meter with a
   daily reset. Positioning.md's business-model paragraph says "nothing to pay us"; the membership is the
   asterisk that paragraph exists not to have.
3. **The credit band cannot host the services worth having.** Ten cents a run, nine to the provider, caps the
   catalog at cached lookups and small compute. An LLM research run, a paid data feed or anything with a
   marginal cost above a few cents is arithmetically excluded, and the snowball audit's remedy (top-ups) turns
   the one thing we said we would never do, meter, into the product.
4. **Supply is zero and the machinery is not.** Roughly 9,000 lines across `api/src/pool`, `creator`, `mcp`,
   the Claude plugin, the example provider, the sandbox's `platform/pool`, the `services` and `provide` skills,
   the editor's membership feature and the `/earn/*` pages, plus Stripe Connect payouts, a monthly close,
   statements, claims, admission gates, canaries and refunds, all run for a catalog of one demo. Every one of
   those is a surface to keep correct, and a promise on a public page.
5. **"Membership" is the wrong noun.** It was chosen for the pool (a member of it). What the buyer actually
   gets, and the only thing that costs us money, is a hosted machine. Naming the plan for the thing bought is
   what makes the page short.

## 4. Options considered

| Option | What it is | Verdict |
| --- | --- | --- |
| A. Keep everything, reorder the copy | Lead with hosting, list credits as a footnote | The five concepts stay on the page; the economics in §2 stay wrong; the zero-supply catalog stays a promise |
| B. Drop hosted, keep the credit economy | intentic is local-only; the $20 buys credits | Removes the one good people pay for and the only zero-install onboarding, keeps the one with no supply. No |
| **C. Drop the credit economy, sell the machine** | The plan is a hosted sandbox. Credits, premium tier, paid services, creator pool, the MCP services plane and the plugin go | **Recommended.** One price, one noun, one cost it covers, every claim on the site true without an asterisk |
| D. Replace credits with real money | Services priced in dollars, top-ups or the wallet, a platform cut | Fixes the arithmetic by starting a second business (payments, payouts, disputes, tax) inside a product whose promise is "we don't meter", with the same empty catalog. If a marketplace is ever wanted, the x402 wallet is the rail, already built, and needs no ledger of ours |

## 5. The model

Two columns, and the question that separates them is the one the positioning doc already asks first: **whose
machine does the agent run on.**

| | Your machine | Our machine |
| --- | --- | --- |
| **Price** | $0 | Free to try, then **$20 a month** |
| **Sandboxes** | As many as the hardware runs | One |
| **Hours** | Unlimited, nothing of ours is running | Free: 40 awake hours a month. Hosted: always on |
| **Kept** | Yours, indefinitely | Free: machine removed after 21 days unopened. Hosted: never reclaimed |
| **Features, capabilities, extensions, teammates** | All of it | All of it, the same |
| **What you also pay** | Your AI providers, directly | Your AI providers, directly |

The plan is called **Hosted**, after the noun the glossary already uses for the rung (`where-it-runs`: "hosted"
against "mine"). Not "Pro", not "Plus", not "Membership": none of those names a thing, and a name that names a
thing is one the reader does not have to decode.

What money changes is whose machine, never what you can do. That sentence is the whole pricing story and it
survives every rule the site already has: free is still the hero chip, "no tiers" stays true because a
feature tier does not exist, "we never meter tokens" stays true because the meter is on our own hardware's
awake time and only until you pay for it.

**What goes:** credits and the daily allowance; the `premium` registry tier and install donations; the
paid-services catalog, admission, probation, canaries, refunds, offers and the wanted list; the creator pool,
its monthly close, statements, claims and Stripe Connect payouts; the `/pool/transparency` ledger; the MCP
services plane, the Claude Code plugin and the example provider; the `services` and `provide` skills; the
`/earn/*` pages and the "Offer a paid service" shelf. The extension registry stays, all of it free.

**What stays off the pricing page:** the wallet (the owner's own money, a capability), the trial (onboarding),
teammates (free, and the comparison shelf's argument against per-seat competitors).

**What does not change:** the free lane's numbers (40 hours, 20 idle minutes, 21 and 14 days), the shape, one
hosted sandbox per account, enforcement at wake rather than mid-session, the Stripe checkout and portal.

### Price and fair use

$20 stays. Anchors: Fly sells the same box for $23 a month with nothing on it; Codespaces bills a 4-core at
$0.36 an hour, $36 for a hundred hours; Conductor puts cloud and teams behind $50 to $60 a seat. Twenty dollars
for an always-on 4 vCPU / 4 GB sandbox that runs the whole product is a price with room in it, and the
comparison shelf already uses it.

The tail in §2 (a member awake more than ~550 hours a month) is real and unpriced. Do not add a member meter
now: the admin cost panel (`admin-costs.ts`, top owners by minutes) already shows whether that tail exists,
and a ceiling built before it has been seen is the kind of number that ends up on a page and then has to be
defended. If it appears, the fix is a `hosted.planMonthlyHours` knob enforced at wake exactly like the free
lane's, published on the page as "up to N hours", and N is read from the panel, not guessed.

### One hosted sandbox

Keep `hosted.perUser` at one for the plan too. "Ten agents in parallel" is ten agents in one sandbox, which
the shape carries; a second hosted sandbox is a second disk and a second box, and the honest price for it is
another plan. Offer that when someone asks, as an add-on, not as a tier.

## 6. The page

`/pricing/` keeps its two equal columns, neither tinted. Copy, in the site's voice (short, no em-dashes, one
idea a sentence), for `site-content/src/pricing.ts`:

- **Heading:** intentic is free. A machine of ours is the one thing we sell.
- **Sub:** Every feature, capability and shared workspace is included on any number of sandboxes on your own
  hardware. Agents run on the AI plans you already pay for; we never meter tokens or add a markup.
- **Column 1, "Your machine", $0, "MIT on GitHub, platform included":** as many sandboxes as your hardware
  runs; every capability, extension and automation; shared workspaces, teammates by email; the desktop app,
  the sandbox API and the whole source tree. CTA (primary): Set up on my computer. Note: You pay your AI
  providers directly. Nothing of ours is running, so nothing is metered.
- **Column 2, "Our machine", "Free, then $20", "a month via Stripe, cancel any time":** free: one hosted
  sandbox, 40 awake hours a month, removed after three weeks unopened; Hosted: always on, no hour ceiling,
  never reclaimed; 4 shared vCPUs, 4 GB memory, 10 GB disk; the same workspace and every feature, on either.
  CTA: Start instantly. Note: Move the workspace to your own machine whenever you like; the plan is the only
  thing you cancel.
- **FAQ.** *Is any of it paid?* The product is not: every sandbox, capability and shared workspace is free,
  with no tiers and no card, and all of intentic is MIT. The one paid thing is a hosted sandbox at $20 a month,
  for people who would rather not run a machine. *Do I need it to run agents?* No. Agents run on your own AI
  accounts and your own machine. Only the hosted sandbox differs: free, it has 40 awake hours a month and is
  removed after three weeks unopened; on the plan it is always on. *Is there a team or enterprise tier?* No.
  Shared workspaces are part of the free product.

Figures come from one module, `site-content/src/hosted.ts` replacing `pool.ts`: `priceUsd`, `freeHours`,
`idleStopMinutes`, `idleDays`, `idleWarnDays`, the shape. Every sentence above that carries a number derives it
from there, for the reason `pool.ts` already gives: a figure typed into copy rots in silence.

Elsewhere: `where-it-runs` keeps its "must not sell a rung" rule and its cost line becomes "Free · 40 hours a
month, always on for $20"; the landing page stays without a pricing band; `positioning.md`'s business-model
paragraph becomes "bring your own model subscription, run it on your own hardware, and pay us nothing; the one
thing we sell is a hosted sandbox for people who would rather not run a machine, and it is never a meter on
model usage or a tier on features"; the economics band's three points stay as they are, because they are true.

In the app: Settings ▸ Membership becomes Settings ▸ Hosted (plan state, awake hours this month on the free
lane, the Stripe button and portal); the avatar menu's credit row becomes the free lane's hours row (the
sandbox summary already carries `hours.allowance` and `hours.remaining`); the offer card says "Keep your hosted
sandbox always on" instead of "Unlock every premium extension"; the hour-cap message at wake already says the
right thing.

## 7. What changes in the source

Sized so the owner can choose how much to do in one go. Everything is a clean removal, no compatibility layer,
per the workspace's CLAUDE.md; the Stripe subscription that used to mean "member" now means "Hosted" and
nothing about it moves.

**Content and naming (one session).** `pricing.ts`, `pool.ts` → `hosted.ts`, `where-it-runs.astro`,
`page-meta.ts`, `structured-data.ts`, `nav.ts` and `developers.ts` (drop Earn and Offer a paid service),
`positioning.md`, `messaging.md`, `landing-blueprint.md`'s pricing note, `_platform/README.md`,
`_platform/prisma/README.md`; the editor's `MembershipOffer.vue`, `SettingsMembership.vue` and the avatar row.

**Removal of the credit economy (the larger part).**

| Area | Remove | Keep |
| --- | --- | --- |
| `_platform/api/src/pool/` | demo, run, catalog, share, close, ledger, admission, offers, wanted, transparency, orpc credit routes | `pool-membership.ts` (entitlement rule, comp list) and `pool-stripe.ts` (checkout, portal, webhook), moved to `_platform/api/src/sandbox/hosted/hosted-plan*.ts` |
| `_platform/api/src/creator/`, `mcp/`, `_platform/claude-plugin/`, `_platform/example-provider/` | All | |
| `_platform/prisma/schema.prisma` | `Donation`, `Service`, `ServiceProbe`, `CreditSpend`, `ServiceRun`, `ServiceOffer`, `ServiceWant`, `PublisherClaim`, `PayoutAccount`, `PoolMonth`, `CreatorStatement`, `CreatorPayout`, the OAuth tables (Better Auth's `mcp` plugin in `auth.ts`, swept by `retention.ts`; the MCP plane is their only user), credit fields on `AdminDailyStat` | `Membership` → `HostedPlan`, `HostedUsage`, `HostedMachine`, `Wallet*` |
| `config.ts` `pool` block | `infraUsd`, `creatorShare`, `serviceShare`, `dailyCredits`, `donationCredits`, `demoService`, `registryUrl`, payout and admission knobs | `stripeSecretKey`, `stripeWebhookSecret`, `stripePriceId`, `priceUsd`, `compEmails`, renamed under `hostedPlan` |
| `_shared/registry` | the `tier` field and its premium semantics | |
| `_shared/api-contract`, `_shared/sandbox-contract` | pool, service, offer, credit schemas | |
| `_sandbox/sandbox` | `src/platform/pool/` (services CLI, offer cards), seed skills `services` and `provide`, the `services` CLI on PATH | wallet |
| `_editor/web` | `features/settings/membership/` → `features/settings/hosted-plan/`; `SettingsPayouts.vue`, `AccountCredits.vue`, `PremiumCost.vue`, the premium chip in `DiscoverCard.vue` and `PluginRegistryBrowse.vue`, `Join.vue`, `Connect.vue`, `ApproveRun.vue`, admin marketplace trends | |
| `_site` | `/earn/*`, `earn.astro`, the earn conversation mock, `pool.ts` | `/pricing/` |
| `docs` | `services-admission-design.md`, `services-integration-snowball.md`, `ops/services-in-claude-code.md`, the pool paragraphs in `architecture/topology.md` and `sandbox.md` | this note |

Tests go with the code they test. `oxlint --deny-warnings`, `knip` and each package's type check are the
proof nothing is left dangling. After the removal a grep for `credits` and `premium` across the tree should find
only the legal attributions page (`_site/site/src/pages/credits.astro`, unrelated) and this note.

## 8. What this does not decide

- Whether $20 is right in a year. The panel's top-owners table and the plan's conversion rate are what decide
  that; the model above is what makes either number legible.
- A second hosted sandbox per account, or a bigger shape. Both are add-ons priced against a real ask.
- A marketplace. If one is ever wanted, it starts from the wallet (real money, any price, no ledger of ours)
  and from supply that exists, not from an allowance.
