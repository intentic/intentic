# Billing end to end: what is tested where, and what going public still needs

Written 2026-09-06 from the source as it stands, the day after [billing-view.md](billing-view.md) landed the
Billing page. The question asked: as the hosted plan goes on sale, will payments, the mirror and "is this
person on the plan" fail in ways nothing catches, and should there be end-to-end tests? The answer, stated
once here and argued below: **yes, in three tiers, because the money path was tested only module by module
against shapes we wrote ourselves. Writing them found four defects: the webhook's ordering guard dropped
events for good, the free lane's refusal went out as HTTP 500, both `.env.example` files still documented the
variable names of the plan's predecessor (under which the plan silently does not exist), and a plan on sale
without a webhook secret said nothing.**

Every file below is read from the tree.

## 1. What was there

The money path is four files under `_platform/api/src/sandbox/hosted/`: `hosted-plan.ts` (the entitlement
rule, the mirror write, the cancel-on-deletion), `hosted-plan-stripe.ts` (a hand-rolled Stripe client over
`fetch`: checkout, portal, one read, cancel, quantity, signature verification), `hosted-plan.orpc.ts` (the
Billing page's state, checkout, portal, slots) and `hosted-plan.routes.ts` (the webhook). Its readers are the
wake and provision gates (`sandbox.routes.ts`), the hour meter (`hosted-usage.ts`), the idle sweep
(`hosted-idle.ts`), Better Auth's deletion hook (`auth.ts`) and the erasure (`admin-actions.ts`); its one page
is `SettingsBilling.vue`.

What was tested, and what was not:

| Surface | Before | Gap |
| --- | --- | --- |
| Entitlement rule, comp list, slots, cancel-on-deletion | `hosted-plan.test.ts`, a hand-written Prisma | None |
| The webhook | Same suite, hand-built payloads and a hand-built `updateMany` | The guard's real SQL, and payloads shaped by the code that reads them |
| `state`, `checkout`, `portal`, `setSlots` | Nothing | The whole browser half |
| The Stripe client's encoding and parsing | Nothing (every test injects a fake gateway) | A parameter spelled wrong, a field moved by an API version |
| The Billing page's five states, the post-checkout poll | `hostedHours.test.ts` for the sentences | The page itself |
| The chain: webhook → row → wake allowed, offer says "on your plan", meter off | Nothing | The thing the plan is for |
| Stripe itself | Nothing | Everything Stripe could change |

## 2. What was found by reading

1. **The env examples named the predecessor.** `.env.example` and `_tools/selfhost/platform/.env.example` still
   documented `POOL_STRIPE_SECRET_KEY`, `POOL_STRIPE_PRICE_ID`, `POOL_STRIPE_WEBHOOK_SECRET` and
   `POOL_COMP_EMAILS`; `config.ts` reads `HOSTED_PLAN_STRIPE_*` and `HOSTED_PLAN_COMP_EMAILS`. An operator
   following either file gets a platform on which `hostedPlanEnabled` is false: no Billing tab, the webhook
   404s, and no error anywhere. Both files now carry the `HOSTED_PLAN_*` block (the compose file already did).
2. **A plan on sale without a webhook secret was silent.** With the key and the price set and the secret not,
   every checkout is charged and every webhook refused (400, bad signature), so nobody who paid activates, and
   Stripe disables the endpoint after three days of retries. `main.ts` now says so at boot, at error level.
3. **The Stripe client's address was a constant.** Nothing could stand in for Stripe without rewriting the
   client, which is why nothing had. It is now config, `hostedPlan.stripeApiUrl` (`HOSTED_PLAN_STRIPE_API_URL`,
   default `https://api.stripe.com/v1`, never set in production), and the client takes the plan's config
   block rather than a bare key.

## 3. What was found by running

The hermetic tier's first run failed six of fourteen tests, all one cause. The webhook's ordering guard
compared the row's `syncedAt` (our clock, milliseconds, stamped by the checkout path and by a slot change)
against the event's `created` (Stripe's clock, whole seconds). Every event Stripe emitted in the same second
as a write of ours therefore compared as OLDER and was dropped for good, Stripe having heard its 200. In a
suite where a checkout, a slot change and a cancel happen within four seconds that is every lifecycle event;
in production it is the narrow case of an event in the same second as (or, with clock skew, shortly after)
a platform write: a cancel made right after adding a slot, a status change Stripe emits as a consequence of
our own quantity write.

The fix is the pattern Stripe's own webhook guidance gives: **no event's copy of the subscription is ever
mirrored.** The event names the subscription; the handler reads it fresh, stamps the read on the platform's
own clock, and the guard compares reads against reads, one clock. `applySubscription` takes `at` (when the
subscription was read) in place of `eventAt`; `subscriptionIdOfEvent` replaced `subscriptionFromEvent`; the
event's `created` is no longer read at all. The unit tests were rewritten to say the new property (an event
carrying a state Stripe has left does not roll the row back; a read older than the row is dropped; an event
whose object is not a subscription asks Stripe nothing).

The second run found the other one. **The free lane's refusal went out as HTTP 500.** `PAYMENT_REQUIRED` is
the platform's own code, not one of oRPC's fourteen, and `fallbackORPCErrorStatus` maps a code it does not
know to 500. So every user who reached their monthly hour ceiling — at a wake, a restart, a provision or an
overlay build, the four sites — was answered "internal server error". Nothing on screen was wrong, which is
why it had never been noticed: the code rides the response body, so `useSandbox`'s wake reflex kept the
refusal and the gate offered the plan exactly as designed. What it cost was the operator's reading of their
own platform, on the day that reading matters most: the single most common *expected* refusal, and the one
moment the plan is deserved, arriving in the logs and in any error monitoring as a fault, indistinguishable
from a real fault. The three throws and the build-refusal map now go through `paymentRequired()`, which
states `status: 402`. It is pinned twice: in the hermetic tier over real HTTP, and in `sandbox.test.ts`, which
runs on an ordinary `pnpm test`. `PAYMENT_REQUIRED` was the only unknown code in the API; the other seven the
platform throws are all in oRPC's table.

## 4. The three tiers

**Hermetic** (`pnpm e2e:hermetic`, every merge request, the CI sidecar the CLI's hermetic tier already runs
in): [hosted-plan.e2e.test.ts](../../_platform/api/src/e2e/hosted-plan.e2e.test.ts). The real api
(`createApp`: the real router, Better Auth's real session and its real deletion hook) on a Postgres
testcontainer with the real migrations replayed, and Stripe stood in for by
[stripe-fake.ts](../../_tools/testing/src/stripe-fake.ts) at the client's one seam. In order: the offer as a
signed-out and a signed-in reader see it; a spent free month refusing the wake with `PAYMENT_REQUIRED`; the
checkout the real client encoded (every parameter asserted) and the nothing it writes; the paid checkout
turning into a row and into every consequence (the Billing state, the offer's `plan: true`, the meter
unmetered, the slot count, the wake that reaches the provider); a second checkout refused before Stripe is
asked; a slot bought with proration, refused under a standing machine, capped by the contract; the portal;
a cancel mirrored as "ends"; a failed charge pausing the plan and bringing the meter back; unsigned, wrongly
signed and stale-signed webhooks refused; events in any order and the same event twice; an ended plan and the
same customer buying again (one row, the unique columns holding); the account deleted through Better Auth
with the subscription cancelled on Stripe first; the comp list. A Docker daemon is the whole requirement.

**Browser** (`pnpm e2e:browser`, a dev machine):
[hosted-plan-billing.spec.ts](../../_tools/e2e/specs/hosted-plan-billing.spec.ts). global-setup starts the
same stand-in and boots the api with the plan on sale against it. Subscribe leaves for the stand-in's checkout
page, Pay sends the browser home BEFORE the webhook (five seconds later, the production shape), and the page
polls into "always on" rather than showing the offer to somebody who just paid; then the avatar row, a cancel
in the portal said as "ends" and never "renews", a failed charge asking for a card, an ended plan offering a
resubscription. It stands down on a reused dev api.

**Stripe** (`pnpm e2e`, nightly, gated on `HOSTED_PLAN_E2E_STRIPE_SECRET_KEY` + `HOSTED_PLAN_E2E_STRIPE_PRICE_ID`):
[hosted-plan-stripe.e2e.test.ts](../../_platform/api/src/e2e/hosted-plan-stripe.e2e.test.ts). The
real client against Stripe's test mode: a customer with the test card, a subscription, then every call the
client makes and the shape of what comes back (a period end Stripe actually stated rather than the client's
"now" fallback, which is what a moved field would produce silently), the event log's objects, the portal, the
cancel. A live key is refused before anything is created. This is the only tier that can see Stripe move a
field under an API version, or a portal with no configuration saved, and it is the one that needs a person
to hand it a test-mode key.

The two stand-in tiers cannot vouch for Stripe's shapes; the Stripe tier cannot run without a credential. The
three together are the coverage; none alone is.

The stand-in has a suite of its own
([stripe-fake.integration.test.ts](../../_tools/testing/src/stripe-fake.integration.test.ts), ordinary
`pnpm test`) covering the half the hermetic tier does not reach: its checkout and portal PAGES, which only
the browser tier drives, and that tier is dev-machine-only, so those pages would otherwise be checked by a
person mid-journey and by nothing else. It pins the order that matters (Pay redirects to the success URL
*before* the webhook is delivered, which is the gap the Billing page polls through), the portal's
cancel-at-period-end leaving the subscription active and saying it will end, the control door the browser
specs drive, Stripe's refusal envelope, and the signature recipe stated from `node:crypto` rather than
transcribed as a digest.

**The browser tier is written but has not been run in this environment.** Its global setup replays the
migrations into the shared dev Postgres, which has a migration stuck part-applied since 2026-09-03
(`20260831120000_ingress_reachability`, unrelated to any of this): `prisma migrate deploy` refuses with P3009
before any spec starts. Clearing it means `migrate resolve` or a volume reset on a database a dozen live
conversations in this workspace read, which is not a call to make in passing. Its selectors were checked
against the components by hand and follow the same `getByRole`/label pattern the existing specs use, but that
is a weaker statement than a green run, and it is the one part of this work still owed one.

## 5. Before the plan goes on sale

Things the tests cannot check because they live in the Stripe dashboard or in a deployment's environment:

- [ ] `HOSTED_PLAN_STRIPE_SECRET_KEY` is a **live** restricted key with: Checkout Sessions write, Customer
      portal write, Subscriptions write, Customers read. `HOSTED_PLAN_STRIPE_PRICE_ID` is the live recurring
      price; `HOSTED_PLAN_PRICE_USD` states the same number.
- [ ] A webhook endpoint at `https://<api origin>/hosted-plan/webhook` subscribed to exactly
      `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, and its
      signing secret in `HOSTED_PLAN_STRIPE_WEBHOOK_SECRET`. The api logs an error at boot without it.
- [ ] The customer portal's default configuration saved, in test mode and live mode both, with subscription
      updates **off** (the app's slot rule is the only one, billing-view.md §3) and cancellation on.
- [ ] `HOSTED_PLAN_E2E_STRIPE_SECRET_KEY` + `_PRICE_ID` (test mode) added as protected CI variables, so the
      nightly Stripe tier runs; and the same pair on the deployment's test-mode counterpart of the checklist
      above, so the tier's portal test is the dashboard step's proof.
- [ ] One real test-mode purchase through the deployed site before the live key goes in: the page must reach
      "always on" without a reload. That single walk is what the browser tier rehearses.
- [ ] `pnpm e2e:browser` once, on a machine whose dev Postgres is healthy, to prove the billing journey (see
      §4: it has not yet had a green run).

## 6. What this does not decide

- Whether the webhook should verify the event against Stripe's `/v1/events/:id` as well (a stolen signing
  secret is the threat; rotating it is the remedy, and Stripe's recommended one).
- A second webhook event (`invoice.payment_failed`) for a faster "needs a card": `customer.subscription.updated`
  already carries `past_due`, and the page reads it.
