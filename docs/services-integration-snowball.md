# Integrating existing services — what starts the snowball

An analysis of the paid-services model as built, and an exploration of how to make listing an **existing**
service cheap enough that supply compounds: more services → agents succeed more often → members spend →
providers earn → more providers list. Companion to
[services-admission-design.md](services-admission-design.md), which covers how a listing is admitted; this
note covers why few will arrive through that door as it stands, and which doors to add.

## The model as built — one paragraph per side

**Demand.** An agent in any sandbox discovers the catalog with `services list` (price, description, worked
sample request, probation badge) and asks with `services run`. The ask raises an approval card in the owner's
chat; the click is the only thing that releases spend, one click covers one run, and a run that fails to
answer refunds before a receipt exists ([pool.routes.ts](../_platform/api/src/pool/pool.routes.ts),
[service-offer.ts](../_sandbox/sandbox/src/platform/service-offer.ts)). This is the strongest part of the
design: the trust story is enforced, not promised, which is exactly what lets admission be open.

**Supply.** A provider claims a publisher name (challenge file pushed to a repo the extension registry
already lists), enables Stripe payouts, builds **one new https endpoint** implementing the platform's
contract — verify the HMAC signature, refuse forgeries and replays, answer an NDJSON stream of `status`
lines and one `result` — passes a three-check probe, and publishes straight into probation
([pool-admission.ts](../_platform/api/src/pool/pool-admission.ts),
[creator-services.ts](../_platform/api/src/creator/creator-services.ts)). Probation caps price at 25
credits, badges the listing `new`, and lifts after 50 served runs under a 20% refund rate.

## The arithmetic, stated plainly

With the published defaults ($20 membership, $5 infrastructure, 1000 credits/day, 90% share):

- one credit is worth **$0.0005** — `(20 − 5) / (30 × 1000)`;
- the price band's ceiling (200 credits) is a **10¢ run**, of which the provider nets 9¢;
- the probation ceiling (25 credits) is a **1.25¢ run**; graduating (50 runs) earns **~56¢ total**;
- a member's entire month of credits can direct at most **$15**.

Two consequences follow. First, the model is currently viable only for services whose marginal cost is near
zero — lookups, cached data, small compute. A service with real upstream cost per run (an LLM research run,
a paid data feed) **cannot price inside the band**, so the businesses most worth integrating are arithmetically
excluded until credit top-ups exist (already on the fine-print "not yet" list). Second, this is not a flaw to
fix by raising numbers quietly — the band is the abuse ceiling — but it does mean the snowball must *start*
with cheap-to-serve services, and top-ups are the gate to the expensive ones.

## The three walls an existing-service owner hits

The admission gates are all fair, published, and mechanical. The friction is everything *around* them:

1. **"Build a new endpoint" is the ask, and it shouldn't be.** The world's existing supply speaks REST,
   OpenAPI, and MCP. Our contract is bespoke (deliberately — the stream and the signature are what make
   refunds and consent enforceable). The [example provider](../_platform/example-provider/README.md) is a
   fine reference, but the provider still writes, deploys, TLS-fronts and operates a wrapper. For someone
   with a working service, that is a day of undifferentiated work before the first credit.
2. **The publisher claim assumes you ship an extension.** [creator-claim.ts](../_platform/api/src/creator/creator-claim.ts)
   proves a name by push access to a repo the *extension registry* lists — a publisher not in the registry
   "has nothing to claim yet". A pure API business has no extension and no reason to make one; the identity
   gate should accept what such a business already owns.
3. **Nothing pulls providers in.** The catalog is visible only inside a sandbox (`services list`). A
   prospective provider cannot see demand before building, members cannot browse what exists before
   subscribing, and unmet agent needs evaporate instead of becoming leads.

## Doors to add, in leverage order

> **Status (2026-08-19):** the easy halves of doors 1–3 shipped. Door 1: the baked `provide` skill
> (wrapper + local conformance self-test + hand-off; the agent does not file the listing — creator routes
> stay browser-session-only on purpose). Door 2: domain claims are live (`/.well-known/intentic-claim`,
> dotted-publisher discriminator, endpoints tied to the claimed domain). Door 3: the public catalog
> (`GET /pool/catalog`, rendered at /earn/catalog/) and the wanted list (`services wanted`,
> `POST /pool/wanted`, aggregate published on the catalog). Still open: the MCP scaffold flavor, standing
> budgets, door 4, and the economics work below.

### 1. The agent builds the wrapper — a first-party "list your service" skill

Everything needed already exists in the sandbox: the copyable single-file provider, scaffold + deploy
machinery, and an agent that can hold a conversation. A skill that takes "here is my existing endpoint /
OpenAPI spec / curl example" and then scaffolds the wrapper from the example provider, deploys it, runs the
conformance probe, files the draft, and walks the owner through payouts turns integration from a day of work
into **one conversation in the product itself**. No new platform trust surface, no contract change — the
wrapper is the provider's own code on the provider's own host, exactly as today. This is also the most
on-brand possible demo: the agent economy onboarding its own supply.

A variant of the same scaffold fronts an **MCP server** — each tool becomes a run, the wrapper synthesizes
the stream. MCP is the largest pool of already-agent-shaped services in existence; one scaffold flavor taps
all of it.

### 2. Claim a publisher by domain, not only by registry repo

Add a second proof to the claim: a DNS TXT record or a well-known file on the domain the upstream endpoint
lives under, carrying the same derived token. Existing businesses prove control of what they already own,
the registry path stays for extension authors, and the payout/identity semantics are unchanged. This
removes wall 2 entirely and costs one verifier.

### 3. Close the demand loop

- **A public catalog page.** The listings are already public-shaped (name, description, price, publisher,
  probation state). Publishing them where search engines and prospective providers can see them makes every
  listing a lead-generator for the next one.
- **A wanted list.** When an agent reads the catalog and finds nothing that answers, that miss is the
  single most valuable demand signal the platform has. Log it (the query, never the member), aggregate it,
  publish it next to the catalog: "agents asked N times this month for X and nobody serves it." Providers
  arrive to fill measured demand instead of guessing.
- **Standing budgets, later.** One click per run is the right default and the right launch posture. When
  repeat use becomes real, the coherent extension is a *budget-scoped* consent — the owner grants a
  per-service daily ceiling once, the platform enforces it, every run still lands on the ledger. The gates
  feature already established the precedent (a paid endpoint with no person in the loop has a daily ceiling
  it cannot exceed). This multiplies spend per member without weakening the property that the agent can
  never spend what the owner didn't release.

### 4. A platform-hosted adapter — deliberately last

The maximal convenience — "paste your existing API's URL and key, we translate" — removes hosting entirely,
because the platform's forward would speak plain request/response upstream and synthesize the stream itself.
It is also the only proposal here that changes the trust model: the platform would hold providers' upstream
credentials, and the probe's meaning shifts from "your endpoint conforms" to "your mapping works". Worth
doing once doors 1–3 have proven the pattern and the catalog has enough gravity to justify the custody
burden; premature before then.

## The flywheel these serve

```dag
{ "title": "The snowball", "direction": "LR",
  "nodes": [
    { "id": "supply", "label": "more services", "note": "doors 1, 2, 4", "accent": "1" },
    { "id": "hits", "label": "agents find answers", "note": "catalog matching", "accent": "2" },
    { "id": "spend", "label": "members spend credits", "note": "door 3, budgets", "accent": "2" },
    { "id": "earn", "label": "providers earn", "note": "ledger is public", "accent": "1" },
    { "id": "leads", "label": "wanted list fills", "note": "misses become leads", "accent": "5" }],
  "edges": [
    { "from": "supply", "to": "hits" },
    { "from": "hits", "to": "spend" },
    { "from": "spend", "to": "earn" },
    { "from": "earn", "to": "supply" },
    { "from": "hits", "to": "leads", "dashed": true },
    { "from": "leads", "to": "supply", "dashed": true }] }
```

The loop's weakest link today is the first edge: supply. Doors 1 and 2 are cheap, change no trust boundary,
and reuse machinery that already exists — they are where the push belongs. The economics work (top-ups, or
a wider band with stronger graduation requirements) is the prerequisite for real-cost services and should be
sequenced before any outreach to businesses whose runs cost them actual money.

## The x402 fork — what a crypto rail obsoletes, and what it promotes

Asked after the doors above were written: if agents can pay any endpoint directly — Cloudflare's
Monetization Gateway and AWS CloudFront both now speak x402, the HTTP 402 protocol settling in USDC on Base
with Coinbase as facilitator — does the whole listing-and-paid-services apparatus become obsolete? (State as
of August 2026: Cloudflare's gateway is waitlist-only, its buyer-side Wallets product is announced but not
shipping; AWS's CloudFront integration is generally available; the protocol sits under a Linux Foundation
x402 Foundation whose members include AWS, Cloudflare, Anthropic and Circle.)

The honest answer is that x402 obsoletes **half** of the model — and it is the half this note was trying to
cheapen anyway. It makes the other half the product.

**What a mature x402 web genuinely retires here:**

- **The bespoke provider contract as a payment prerequisite.** A seller behind Cloudflare or CloudFront
  writes a pricing rule in front of an URL they already run; nothing of ours gets implemented. Doors 1, 2
  and 4 above — the wrapper skill, the domain claim, the hosted adapter — exist to manufacture supply, and
  x402 manufactures it at web scale for free.
- **Stripe payouts and publisher claims as prerequisites for being paid.** Funds settle peer-to-peer into
  the seller's wallet; the platform stops being the money intermediary, so the identity gates it needed as
  one stop being admission requirements.
- **The credit-metered forward and the price band** as plumbing. Metering is the rail's job now.

**What x402 does not provide — and therefore promotes from plumbing to product:**

- **The spend gate.** x402 puts a funded wallet in the agent's hands, which is precisely the failure mode
  the current design exists to make impossible. Someone must hold the keys, raise the approval card, enforce
  the daily ceiling, and keep the ledger — the exact machinery already built in
  [service-offer.ts](../_sandbox/sandbox/src/platform/service-offer.ts) and the gates' daily-ceiling
  precedent. In an open-payment web, "the agent cannot spend what the owner didn't release" stops being one
  marketplace's policy and becomes the reason to run the sandbox at all.
- **The refund discipline.** x402 is pay-then-serve with no chargebacks: a dead socket, a garbage answer, a
  malicious 200 all keep the money. Our refund-before-receipt promise is enforceable only because the
  platform sits in the middle. On an open rail, the equivalent is a *reputation layer built from observed
  runs* — the watch generalized from "our listings" to "any endpoint our fleet of agents has paid" — plus,
  optionally, a guaranteed tier where the platform fronts the payment and eats provider failures, priced off
  that reputation.
- **Trustworthy discovery.** Anyone can 402 a URL; nobody vouches for it. A catalog whose quality signals
  come from real, platform-witnessed outcomes across many members is exactly what an agent (and its owner)
  needs before releasing a payment to a stranger's endpoint.

**The clean adoption shape** (no compatibility layer, per this repo's rules): credits stay as the
consumer-facing meter — owners keep paying a flat membership and never touch an exchange — while the
platform's own wallet settles x402 upstream on their behalf. The catalog inverts from "endpoints that
implemented our contract" to "the open x402 web, indexed and reputation-scored by what agents actually
experienced". The signed-forward contract survives only if the guaranteed-refund tier is worth offering;
otherwise it is deleted, along with open admission's probe, Stripe payouts for services, and the service
half of the pool math. The extension-donation half of the pool is untouched — it was never a payment rail.

**What argues for waiting:** the buyer side is not real yet (Cloudflare Wallets is "coming soon", the
gateway waitlist-only), owner-held USDC raises onramp/tax/custody questions the membership neatly avoids,
and platform-custodied wallets raise money-transmission questions the current Stripe model doesn't. The
defensible sequencing is to build the pieces that win in *both* futures — the spend gate, budgets, the
reputation watch, the public catalog — and treat the rail (credits-forwarded-by-us today, x402 tomorrow) as
a swappable back end, which the forward already structurally is.

## What this note deliberately does not propose

- **Weakening per-run consent as a growth lever.** The click is the reason open admission is safe at all;
  budgets extend it, nothing replaces it.
- **Curation as quality control.** The watch answers "is it any good" behaviorally, after listing — adding
  human review back in would throttle exactly the supply this note is trying to grow.
- **Usage-signal payments from sandboxes.** Sandboxes are self-hosted; any signal they send could be
  invented. Only platform-witnessed spend earns, which is the sybil defense the whole pool rests on.
