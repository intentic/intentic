# Paid services in Claude Code

The services catalogue, reachable by a coding agent that has no sandbox — and a membership somebody can buy
from a terminal without ever opening this app. Built; this note is the reasoning and the map. Companion to
[services-integration-snowball.md](services-integration-snowball.md) (why supply is the scarce side) and
[services-admission-design.md](services-admission-design.md) (how a listing gets in).

## What was actually wrong

The economics were never machine-shaped. A membership is an **account's**, the credit meter is an account's,
the catalogue is the platform's, and the ledger pays creators out of what accounts spend. But every metered
route authenticated by a *sandbox's* connect token, and the only place to buy a membership was a tab inside
the workspace shell — whose guard bounces anyone with no sandbox to `/setup`.

So "owns a machine" had become a precondition for paying us, by accident, in two places at once. That is the
bug this fixes. The Claude Code plugin is what makes it visible; it is not really the feature.

## The shape, end to end

```dag
{ "title": "One paid run, from a terminal", "direction": "LR",
  "nodes": [
    { "id": "cc", "label": "Claude Code", "note": "the intentic plugin", "accent": "neutral" },
    { "id": "mcp", "label": "/mcp", "note": "OAuth bearer, three tools", "accent": "1" },
    { "id": "offer", "label": "offer row", "note": "pending, price stamped", "accent": "5" },
    { "id": "page", "label": "/approve/:id", "note": "the owner's browser", "accent": "2" },
    { "id": "run", "label": "metered run", "note": "spend, forward, refund", "accent": "1" },
    { "id": "prov", "label": "provider", "note": "signed, unchanged", "accent": "neutral" }],
  "edges": [
    { "from": "cc", "to": "mcp" },
    { "from": "mcp", "to": "offer" },
    { "from": "offer", "to": "page", "dashed": true },
    { "from": "page", "to": "offer", "dashed": true },
    { "from": "mcp", "to": "run" },
    { "from": "run", "to": "prov" }] }
```

| Piece | Where |
| --- | --- |
| OAuth authorization server | [auth.ts](../_platform/api/src/auth.ts) — Better Auth's `mcp` plugin |
| The MCP door | [mcp/mcp.routes.ts](../_platform/api/src/mcp/mcp.routes.ts) |
| The three tools | [mcp/mcp-tools.ts](../_platform/api/src/mcp/mcp-tools.ts) |
| **The spend gate** | [mcp/mcp-offer.ts](../_platform/api/src/mcp/mcp-offer.ts) |
| The approval page | [ApproveRun.vue](../_editor/web/src/pages/ApproveRun.vue) + `pool.offer` / `pool.settleOffer` |
| Buying without a sandbox | [Join.vue](../_editor/web/src/pages/Join.vue), [Connect.vue](../_editor/web/src/pages/Connect.vue) |
| The plugin | [_platform/claude-plugin](../_platform/claude-plugin) |

Two principals now reach the same routes: `ownerOf` in [pool.routes.ts](../_platform/api/src/pool/pool.routes.ts)
resolves a sandbox connect token **or** an OAuth bearer, and everything under it is unchanged, because
`ownerId` is all any of it ever wanted. The money itself was lifted into
[pool-run.ts](../_platform/api/src/pool/pool-run.ts) and [pool-catalog.ts](../_platform/api/src/pool/pool-catalog.ts)
so the daemon's HTTP route and the MCP tools drive one implementation and cannot drift on what was charged.

## The gate, and the one rule that makes it honest

In a sandbox the gate is alive: the CLI call parks inside the daemon, a card goes up in the owner's turn, and
the held socket **is** the waiter. None of that survives the trip to a stranger's laptop. So the offer became
a row, and the row is the grant.

> **`pending` → `approved` happens only in the browser, under the owner's own session.**

The MCP client's elicitation answer is never read as consent and never touches the table. That is deliberate
and load-bearing: Claude Code ships an `Elicitation` hook that can auto-answer the dialog without showing it,
and a user who configures one must not thereby be spending. An auto-answered dialog produces a retry that
finds a `pending` row and refuses. `mcp-offer.test.ts` pins exactly that case.

The rest follows the sandbox's semantics:

- **One approval, one run** — `approved` → `spent` is a conditional update, so a retried tool call charges
  once and the second reads `already_spent`.
- **A yes goes cold.** An unanswered ask stands ten minutes; an approval stays spendable for fifteen after it
  is given. Consent to spend is consent to spend *now* — a grant found hours later belongs to a conversation
  that is over.
- **A "no" is said once.** A declined offer answers the protocol's own retry, then stops mattering after two
  minutes, so asking again later raises a fresh card rather than replaying an old refusal.
- **Prices cannot move under someone.** `credits` is stamped on the offer when it goes up; the page, the
  charge and the receipt all read that number.
- **Headless refuses.** `claude -p` and SDK sessions cannot show the dialog, so they cannot get a grant.

## Buying without the product

`/join`, `/connect` and `/approve/:id` are outside the workspace shell — deliberately, and that placement is
the whole point rather than a layout preference. Everything under `/` is guarded by `requireSetup`.

The offer itself is one component ([MembershipOffer.vue](../_editor/web/src/components/MembershipOffer.vue))
shared with the settings tab, so the two buying surfaces cannot come to disagree about what a membership is
— on the one page in this product where being wrong costs trust rather than a rerender. Checkout takes a
`returnTo` lane (an enum, never a URL: a caller-supplied return address on a payment redirect is an open
redirect waiting to be found) so Stripe returns somebody to the page they started on.

The finish line matters more than it looks. Somebody who came from a terminal is sent **back to their
terminal**, with the three things to do next — not dropped into a workspace shell they never asked for, which
is what every other "you're a member" surface in this product does.

## Deliberate non-goals

- **Credit top-ups.** The membership grants a daily allowance from config; there is no balance and no
  one-off purchase. That is a pricing decision, not an implementation gap — and per the snowball note it is
  the prerequisite for services whose runs cost their provider real money, which is exactly the kind a Claude
  Code audience will ask for. Building it means a balance column, a second Stripe price, and spend/refund
  ordering across two buckets.
- **The wallet.** x402 needs custody, a policy engine and the quarantined-turn rule that strips a poisoned
  turn's auto-approve band. That machinery belongs to a sandbox and does not travel. The metered, refunded,
  catalogued rail is the one that survives leaving home.
- **Standing budgets.** One click per run is the right posture for a stranger's first paid run, exactly as it
  was in the sandbox. Budget-scoped consent is the coherent later step and needs the ledger behind it anyway.
- **A pasted API token.** The credential and the price sentence both belong out of the model's reach, which
  is what OAuth plus a server-rendered page buys.

## What is still true from the analysis

**The catalogue is empty.** `GET /pool/catalog` on the live platform answers `{"services":[],"wanted":[]}`.
This plumbing is inert until there is supply, and the snowball note's doors are what produce it. Turning
`POOL_DEMO_SERVICE` on makes the whole path demonstrable end to end without recruiting anybody.

**The arithmetic gates the audience.** One credit is $0.0005 and the band's ceiling is a 10¢ run — fine for
lookups, impossible for anything with real upstream cost. Sequence top-ups before pointing this at people who
want paid research.

**The strategic trade is real and was argued in the affirmative.** The gate was the reason to run a sandbox,
and handing it to Claude Code gives away the home-field advantage. The counter stands: a gate nobody can
reach is not a product, the scarce side is demand, and a service ships no code at all — so what actually does
not travel (isolation, the policy engine, the untrusted-content quarantine) matters far more to the wallet
than to a catalogue of vetted, refunded, signed forwards. This is a funnel, not a hedge.
