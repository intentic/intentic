# Open admission for paid services

How a third-party business lists a metered service **without a human in the loop**: the rules, the gates, and
what each one is actually protecting.

Today a listing is a row an operator writes by hand after a Discord conversation
([pool-demo.ts](../_platform/api/src/pool/pool-demo.ts) seeds the only automatic one). That is a fine way to
onboard the first three providers and a terrible way to onboard the next three hundred. This document is the
replacement: a published algorithm anyone can read, run against themselves, and predict the outcome of.

## Why this can be automated at all

**The member's safety was never coming from curation.** It comes from the spend gate in
[service-offer.ts](../_sandbox/sandbox/src/platform/service-offer.ts): the agent cannot spend, one click
releases exactly one run, every number on the card is read from the platform's own catalog, and a run that
does not answer is refunded before anyone sees a receipt. A malicious listing's entire blast radius is a few
small, refundable, individually-approved charges: and none of its code ever runs on anyone's machine,
because a service ships no code at all.

That leaves human review guarding exactly three things, all of which are mechanical questions:

| What review was really checking | The mechanical form |
| --- | --- |
| Is this a real, reachable, accountable business? | A claimed publisher name plus a payout-ready account |
| Does the endpoint actually implement the contract? | A live probe that a wrong signature must fail |
| Does the listing text and price describe what it does? | Bounded fields, a price band, a reserved-word check |

Everything left over ("is the answer any good") is not knowable at admission time by any reviewer, human or
otherwise. It is a **behavioral** question, so it is answered behaviorally, after listing, by the watch.

## The lifecycle

```dag
{ "title": "A listing's states", "direction": "LR",
  "nodes": [
    { "id": "draft", "label": "draft", "note": "editable, invisible", "accent": "neutral" },
    { "id": "probation", "label": "probation", "note": "live, capped, badged", "accent": "2" },
    { "id": "listed", "label": "listed", "note": "full price band", "accent": "1" },
    { "id": "suspended", "label": "suspended", "note": "history kept", "accent": "5" }],
  "edges": [
    { "from": "draft", "to": "probation" },
    { "from": "probation", "to": "listed" },
    { "from": "probation", "to": "suspended" },
    { "from": "listed", "to": "suspended" },
    { "from": "suspended", "to": "probation", "dashed": true }] }
```

A suspended listing is never deleted and its runs stay on the public ledger: the registry's reasoning about
blocked rows applies here too, and for the stronger reason that its earnings history is somebody's money.

## The four gates

Gates 1–3 run at `publish`, synchronously, and are the whole admission decision. Gate 4 runs forever.

### Gate 1: identity

The caller must **hold a publisher claim** for the name the listing publishes under, and their account's
**payouts must be enabled**.

Both halves already exist. [creator-claim.ts](../_platform/api/src/creator/creator-claim.ts) proves a
publisher name by a token committed to a repository the official registry lists under it, and
[creator-payouts.ts](../_platform/api/src/creator/creator-payouts.ts) reads a connected account's readiness
back from Stripe, which collected the identity documents the platform deliberately never sees.

Requiring payouts *before* listing rather than before the first payment is the anti-spam design. It costs a
spammer a verified identity per listing and costs an honest provider nothing they were not going to do anyway.

### Gate 2: conformance

A **live probe** of the declared endpoint, run by the platform against the secret it just minted. Three calls,
all three must pass, no credits involved:

| Check | What is sent | Required answer |
| --- | --- | --- |
| `serves` | A correctly signed probe body | A valid stream ending in one `result`, inside budget |
| `rejectsForgery` | The same body, wrong signature | Any non-2xx |
| `rejectsReplay` | Correct signature, timestamp far in the past | Any non-2xx |

The first proves it implements the contract. The other two prove it **verifies**, which is the only reason the
signature exists: an endpoint that answers a forged call is one that anyone on the internet can bill against
the provider's own upstream costs, and admitting it would be doing them harm.

The probe reuses [pool-services.ts](../_platform/api/src/pool/pool-services.ts)'s real forward, so what is
tested is the exact code path a paid run takes: including its five-minute budget, which is why a probe
against a slow endpoint is a slow call. A probe that passed is stamped and expires; publishing needs a fresh
one, because a probe's whole claim is about right now.

Changing a live listing's endpoint therefore drops it back to `draft`. An endpoint that could be swapped for
an unproven one after admission would make this gate decorative: it proves an endpoint, not a promise.

### Gate 3: listing rules

Bounded, published, checkable by the provider before they ever call the platform:

- **Slug** matches the publisher name's shape, is unique, and is not reserved.
- **Publisher** equals a name this account has claimed.
- **Name and description** are within length bounds and carry no reserved marketing words (`official`,
  `intentic`, `verified`) unless the publisher is the platform itself.
- **Price** is inside the published band, and inside the tighter probation ceiling on the way in.
- **Endpoint** is `https`, resolves to a public host, and is not a private or loopback address.

This is a rules engine, not a judgment. It exists so a listing cannot *claim* to be something it is not on the
one surface the member reads before clicking.

### Gate 4: the watch

Behavior is a service's only artifact, so it is the whole ongoing review. Three mechanisms, all threshold
numbers published as configuration:

- **Graduation.** Probation lifts after `graduationRuns` served runs whose refund rate stayed under
  `maxRefundRate`. Nothing is judged; the counter is the decision.
- **Tripwire.** Any listing whose refund rate over its last `watchWindowRuns` exceeds `maxRefundRate` is
  suspended immediately. A provider that stopped answering stops being offered.
- **Canary.** Listed services are re-probed on the daily cycle. `canaryFailures` consecutive failures suspend
  it. This is what catches a service that quietly died rather than one that answers badly.

A suspension states its reason, and the provider can fix and re-publish, which re-enters probation. Nothing
here needs an operator, and every threshold is a number the provider can read in advance.

## What this deliberately does not solve

**Semantically bad answers.** A service that returns a confident, complete, wrong answer passes every gate
above: no refund fires, because it served. Only member feedback catches that, and the honest thing is to say
so rather than to pretend a probe could. The published run ledger and a future thumbs signal on the receipt
card are where that belongs; until then, a bad service is caught the slow way, by reputation.

**Price gouging inside the band.** The probation ceiling and a rate limit on price changes bound how fast this
can move, not whether it can happen.

**Sybil listings by one identity.** One verified identity can hold several publisher names, bounded only by
the per-account listing cap (which counts drafts, so unlimited drafts cannot route around it, and exempts
suspended rows, so keeping your history is never a reason not to list again). A refundable credit deposit is
the obvious next lever and is not built here: the payout-readiness requirement is already a real cost, and a
deposit should be priced against observed abuse rather than guessed at.

## Rollout

The gates ship enabled. `POOL_OPEN_ADMISSION` turns the self-serve path off entirely for a platform that wants
the old hand-written flow, and operator-created rows (the demo service among them) keep working unchanged:
they carry no owner, so no gate applies to them and nothing about the existing catalog moves.
