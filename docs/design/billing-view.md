# Billing: where the plan is seen, stopped and enforced

Written 2026-09-06 from the source as it stands, after [pricing-model.md](pricing-model.md) landed the hosted
plan as the one paid thing. The question asked: there is no "Billing" view that tells a person what plan they
are on and lets them stop it; where should it live, and what does the plan do about a person with more than
one sandbox; and is a machine actually bound to its owner's plan? The answer, stated once here and argued
below: **rename Settings ▸ Hosted to Settings ▸ Billing and make it the one page about money; sell the plan per
hosted sandbox (a slot), never per hour; and close four holes first, because today a person can cancel and be
told they renew, delete their account and keep paying, run out of hours and never be offered the plan, and keep
a free machine awake forever for nothing.**

Every file below is read from the tree; every figure is from `_platform/api/src/config.ts` or
[pricing-model.md §2](pricing-model.md).

**Status (2026-09-06, same day):** all four steps of §6 landed. §1 and §2 describe the tree as it was that
morning and are kept as the record of why; the code now is §4 and §5: `SettingsBilling.vue` at
`/settings/billing`, `hostedHours.ts` for the shared sentences, the wake refusal kept in `useSandbox.ts` and
said by `connectionNotice.ts`, `hosted-meter.ts` for the hourly tick, `hostedPlan.setSlots` for slots, and
`cancelHostedPlan` on both deletions.

## 1. What exists

| Surface | Where | What it says |
| --- | --- | --- |
| Settings ▸ Hosted | `_editor/web/src/features/settings/SettingsHosted.vue`, tab in `SettingsHub.vue`, route `/settings/hosted` | Four states: the offer (`HostedPlanOffer.vue`), on the plan ("renews …", **Manage on Stripe**), lapsed (past_due/unpaid/incomplete, **Update payment**), activating (polls after checkout). Tab exists only when the platform sells a plan |
| Setup wizard lead card | `features/setup/Setup.vue:522` | "On your plan · always on" / "Free to try · 40h a month, always on with the plan" / "Free · ready in seconds" |
| Sandbox ▸ Overview | `features/sandbox/overview/SandboxOverview.vue:407` | "a small starter machine we host for you … move it to your own device: no hour limit" |
| The connecting gate | `features/sandbox/gates/connectionNotice.ts` | A hosted machine not answering for a minute: "Check the machine" → /setup |
| Avatar menu | `shell/AccountPanel.vue` | Email, Settings, Sign out. No plan or hours row |
| Sandbox ▸ Usage | `features/sandbox/usage/` | AI-provider plan quotas (Claude, Google), not money. Wears the `credit-card` icon |
| Admin | `admin-attention.ts` (past-due plans), `admin-costs.ts` (top owners by minutes), `admin-user.ts` (plan status) | Operator's view, complete enough |

The platform side: `HostedPlan` (one row per user, Stripe status verbatim, `currentPeriodEnd`), `HostedUsage`
(minutes per owner per month), `HostedMachine` (unique per sandbox), the Stripe gateway (checkout, portal,
one subscription read, webhook verify), and the entitlement rule `isOnPlan` = active or trialing.

## 2. Findings

### The page
1. **The purchase moment is invisible.** `sandbox.wake` refuses with `PAYMENT_REQUIRED` when the owner's hours are
   spent (`sandbox.routes.ts:579`), with a comment that says "so the editor can offer the hosted plan without
   string-matching a message". The editor's wake reflex is `apiClient.sandbox.wake(...).catch(() => undefined)`
   (`useSandbox.ts:187`) and no editor code reads `PAYMENT_REQUIRED` anywhere. The person sees the connecting
   gate, then after a minute "Check the machine", then the setup screen. The one moment the plan is deserved,
   the product describes an outage.
2. **No hours meter after setup.** `hostedOffer.hours` is read by `Setup.vue` alone. pricing-model.md §6 planned
   the avatar menu's credit row becoming the hours row; `AccountPanel.vue` has no such row. A free-lane owner
   cannot learn how much is left until the wake refuses, and then (1) applies.
3. **Cancelling is not reflected.** Stripe's portal cancels by setting `cancel_at_period_end = true`; `status`
   stays `active` until the period ends. `SubscriptionSchema` (`hosted-plan-stripe.ts:60`) does not read the
   field, `HostedPlan` has no column for it, and the card keeps saying "renews October 1" to a person who just
   cancelled. The exact errand this note is about ends on a screen that contradicts it.
4. **Two surfaces, two answers for a comped account.** `hostedPlan.state` (`hosted-plan.orpc.ts:27`) reads the
   `HostedPlan` row through `isOnPlan` and never consults `compEmails`; `hostedOffer` uses `onHostedPlan`, which
   does. A comped owner (production's `HOSTED_PLAN_COMP_EMAILS`) sees **Subscribe for $20/month** in Settings while
   the setup card says "On your plan · always on".
5. **A plan with nothing under it.** A subscriber who deletes their hosted sandbox, or whose machine the
   provider lost, pays $20 a month for no machine. No surface says "your plan covers a hosted sandbox and you
   don't have one".
6. **The word.** "Hosted" between Profile and Appearance reads as a preference. A person looking to stop paying
   looks for "Billing" or "Plan", and the first thing in this app wearing a bank-card icon is Sandbox ▸ Usage,
   which is about Claude quotas.

### The money
7. **Deleting an account does not cancel the subscription.** Better Auth's `deleteUser` (`auth.ts:53`) and the
   admin erasure (`admin-actions.ts:38`, whose message says "the hosted plan's mirror are gone with the account")
   both cascade the `HostedPlan` row. The gateway has no cancel call. The customer is charged monthly with no
   account to open the portal from, and every later webhook for that customer matches no row and is dropped.
8. **Checkout never reuses the customer and never refuses.** `checkoutSession` passes `customer_email` and no
   `customer`, so every checkout mints a new Stripe customer (a resubscriber's invoices split across two), and
   `checkout` does not check `isOnPlan` first: two tabs on the offer make two subscriptions, the upsert keeps one
   row and the other charges invisibly.
9. **Webhooks apply last-writer-wins.** `customer.subscription.updated` events can arrive out of order; the row
   takes whichever lands last. Minor; Stripe documents it and the fix is a `created` comparison.

### Enforcement (question 2)
10. **Binding is sound.** `HostedMachine.sandboxId` is unique → `Sandbox.ownerId` → `HostedPlan.userId` unique.
    Every spend path bills or checks the sandbox's **owner**, never the caller: wake (`:576`), provision
    (`requireOwnedSandbox` then `assertHostedAllowance(user.id)`, `:340`), restart (`:484`), overlay build
    (`:528`), idle sweep (`hosted-idle.ts`). Members may wake a shared sandbox and spend the owner's month. No
    ownership-transfer route exists, so the binding cannot drift. `perUser` is counted by `sandbox.ownerId`.
11. **The ceiling is a stopping cap, not an hours cap.** A stretch is charged when the machine stops
    (`hosted-usage.ts`, which says so: "a machine which never sleeps is never charged, which is exactly the gap").
    Stopping is decided inside the box by the daemon's five probes (`_sandbox/sandbox/src/system/idle-stop.ts`),
    one of which is tmux activity, and the owner is root in there. `while true; do date; sleep 30; done` in a
    pane keeps a free machine awake and unbilled for a month; a preview URL somebody polls does the same by
    accident. The daily sweep only settles machines that have **stopped**. The plan is optional for anyone who
    has read that file.
12. **The meter under-reads while the machine is up.** `hostedBudgetOf` sums settled rows only; an open
    `wokeAt` contributes nothing. A machine awake 39 hours straight reads "40 h left". The gate and every meter
    built on it would lie in the same direction.
13. **Slots are not modelled.** `perUser` is one config number for everybody; the plan cannot cover a second
    sandbox even where we would want to sell one.
14. Past-due pauses the plan and meters the month honestly (minutes were recorded all along: `chargeMinutes`
    runs for everyone). Builds are refused up front when fewer minutes remain than the timeout. Both fine.

## 3. Question 1: one sandbox, many sandboxes, or hours

The unit of cost is a **machine**: $1.50 a month of disk whether it sleeps or not, plus $0.032 an awake hour
(pricing-model.md §2). Hours do not bound disk: ten sleeping sandboxes cost $15 a month with no hour spent. So
a pool of hours across sandboxes is the wrong bound, and it puts a meter back on the page the pitch just took
one off. A feature tier is ruled out by the model itself (money changes whose machine, never what you can do).

| Option | Bound on our cost | Reads as | Verdict |
| --- | --- | --- | --- |
| Plan = 1 sandbox, always on (today) | Yes | "one machine, $20" | Right, but leaves the second-sandbox ask unanswerable |
| Plan = N hours across any sandboxes | No (disk) | A meter | No |
| Tiers by size or by count | Yes | Pro/Team | Wrong noun for this product; no demand signal yet |
| **Plan = $20 per hosted sandbox (slot), quantity on the one subscription** | Yes | "each machine is $20" | **Recommended.** What pricing-model.md §5 called "an add-on, not a tier" |

The policy, in full:

- **Free lane:** one hosted sandbox per account, 40 awake hours a month, removed after 21 days unopened.
  Unchanged.
- **Hosted plan:** $20 a month **per hosted sandbox**. The subscription item's `quantity` is the number of
  slots; the first slot is the free machine made always on. Effective allowance
  `slots = onPlan ? plan.quantity : config.hosted.perUser`, read by the provision gate and the offer.
- **Add a slot** in the app ("Add a hosted sandbox · +$20/month"): the platform sets `items[0][quantity]` on the
  subscription with Stripe's default proration; the webhook mirrors `quantity`. **Remove a slot** in the app,
  refused while machines ≥ quantity ("remove a sandbox first", the provision gate's own rule in reverse). The
  portal's subscription-update feature stays **off** so the app's rule is the only one; the portal keeps payment
  method, invoices and cancel.
- **Cancel** (in the portal): at period end every machine falls to the free lane. `HostedUsage` is already per
  owner, so N machines share the 40 hours with no new logic; idle collection applies; nothing new can be
  created while machines ≥ `perUser`. A coherent fallback that needs no code.
- **Fair use on the plan:** stays unmetered, as pricing-model.md decided, but awake hours are recorded (they
  already are) and **shown** on the Billing page ("awake 212 h this month"). When the tail in §2 appears in
  `admin-costs`, `hosted.planMonthlyHours` becomes a number people have already seen, and finding 11's fix
  below is what makes it enforceable the day it is set.
- **Shape:** do not tier it now. Say what a slot is (4 shared vCPUs, 4 GB, 10 GB, the same figures the pricing
  page states) on the Billing page, so a buyer knows what they bought. If a bigger box is asked for, it is a
  second Stripe price on the same slot model with `HostedMachine.shape` chosen at provision, never a tier of
  features.
- **Teams:** a shared sandbox's guests spend the owner's slot and month. A team wanting one always-on sandbox
  pays through its owner. Say that in the page's fold rather than inventing team billing.

## 4. Where Billing lives, and what it shows

The plan belongs to the **person** and covers every hosted machine they own, so it is account-scoped: Settings,
from the avatar, the place every comparable product puts it. Rename the tab **Billing** (icon `credit-card`),
route `/settings/billing`, page heading "Hosted plan"; the checkout success and cancel URLs move with it. Give
Sandbox ▸ Usage a meter glyph (`history` or `clock` exist in `iconSets.ts`) so the bank card means one thing in
the app. The tab appears on the same condition as today: the platform sells a plan.

### The page, top to bottom

1. **Plan.** One line for the state, one action:
   - Free lane: "Free lane · 12 h of 40 h left this month · resets October 1" → **Subscribe for $20/month**
     (the existing offer below it).
   - On the plan: "Hosted plan · $20/month · renews October 1" → **Manage on Stripe**.
   - Cancelling: "Hosted plan · ends October 1" and the consequence in one sentence: "After that your hosted
     sandbox is on the free lane: 40 awake hours a month, removed after three weeks unopened. Files stay until
     then." → **Resume on Stripe**.
   - Past due: as today, **Update payment**.
   - Trial: "ends", never "renews", as today.
   - Complimentary: "Hosted · complimentary" with no button and no offer.
2. **This month.** The free lane's meter (used / allowance, resets on the 1st, UTC), live including the open
   stretch. On the plan, the awake-hours figure with "no ceiling".
3. **Hosted sandboxes.** The owner's machines: name, region, "awake since 14:02" or "asleep" (from `wokeAt`, no
   provider call), awake hours this month; "1 of 1 slots" and, on the plan, **Add a hosted sandbox · +$20/month**.
   Zero machines on the plan gets its own sentence: "Your plan covers a hosted sandbox and you don't have one.
   Create one, or cancel." (finding 5).
4. **What a slot is** (a fold): the shape, what free changes to on the plan, teams.
5. **Invoices and payment**: the portal link. Card details never touch this platform, as the offer says.

### The other four surfaces

- **Avatar menu**, a row under the email, a link to `/settings/billing`: free "12 h of 40 h left this month";
  plan "Hosted plan · renews Oct 1" (or "ends Oct 1", or "payment failed"); complimentary "Hosted · complimentary";
  no row on a platform without a plan. This is the row pricing-model.md §6 asked for. **Superseded — see §8.**
- **Sandbox ▸ Overview's hosted card**: the machine's own line ("Hosted in arn · asleep · covered by your plan"
  or "… · 12 h of 40 h left this month") and a link to Billing, beside the existing "move it to your own
  device".
- **The gate, on `PAYMENT_REQUIRED`** (finding 1): the wake reflex reports the refusal to the connection state
  instead of swallowing it, and `connectionNotice` gains a state: title "*name* has used its free hours for this
  month", body "40 awake hours are included free each month; they reset on October 1. Subscribe to keep it
  always on, or move it to your own computer for free.", actions **Subscribe for $20/month** → Billing and
  **Run on my computer** → setup. For a member rather than the owner: "The owner's free hours for this sandbox
  are used up this month", no buy button.
- **A low-hours strip** at ≤ 5 h left (or at the last eighth of the allowance), dismissable for the day, the
  trial's `ChatPaneNotices` precedent: "5 h of hosted time left this month" → Billing.

## 5. What the source grows

**Contract** (`_shared/api-contract`): `HostedPlanState` gains `comped`, `cancelAtPeriodEnd`, `slots`,
`usage: { month, usedMinutes, allowanceMinutes | null, resetsAt }` (live, open stretch included),
`machines: [{ sandboxId, name, region, wokeAt, awakeMinutesThisMonth }]`, `shape`. One read for one page; the
avatar row and the Overview card read the same query (`useHostedPlan` is already "read once for the whole
app"). `hostedPlan.setSlots({ quantity })` is the one new route.

**Schema**: `HostedPlan.cancelAtPeriodEnd Boolean @default(false)`, `HostedPlan.quantity Int @default(1)`,
`HostedPlan.stripeItemId String` (the quantity write needs it). A new migration, no compatibility layer.

**Stripe gateway**: `cancelSubscription(id)` (`DELETE /v1/subscriptions/:id`), `setQuantity(subscriptionId,
itemId, n)`, `customer` on checkout when a row exists; `SubscriptionSchema` reads `cancel_at_period_end`,
`items.data[0].id`, `items.data[0].quantity`, `created`.

**Meter** (`hosted-usage.ts`): `hostedBudgetOf` adds `now − wokeAt` for the owner's open stretches. A new
**hourly** tick beside the pool's five-minute reconcile: settle stopped stretches (as the daily sweep does), then
for a metered owner whose settled + live minutes exceed the allowance by more than a grace hour, **stop the
machine** through Fly (`stopMachine`, the admin brake that already exists) and log it. "Never under someone's
hands" becomes "at most an hour past the ceiling, after the strip said 5 h and the meter said 0"; the daemon's
idle-stop stays the friendly path and this is the backstop that makes the number true. The wake gate then
refuses, and the gate above finally says why.

**Deletion**: Better Auth's `user.deleteUser.beforeDelete` hook and `deleteUserAccount` both read the plan row
and call `cancelSubscription` before the cascade; a Stripe refusal logs and proceeds (a deleted account must not
be blocked on a payment API), and the attention feed lists the customer for a manual cancel.

## 6. The order

Sized so each step lands on its own and the earlier ones are the ones that cost money if skipped.

1. **The money is right** (one session): finding 7 (cancel on both deletes), 8 (refuse when on the plan,
   reuse the customer), 3 (mirror `cancelAtPeriodEnd`), 4 (`state` through `onHostedPlan`, `comped`), 9 (the
   `created` guard). Tests beside `hosted-plan.test.ts`.
2. **The meter is true** (same or next session): finding 12 (live minutes), finding 11 (the hourly tick with
   the grace stop), `resetsAt`.
3. **The surfaces** (one session): the contract growth; the tab rename and route; the five page states; the
   avatar row; the Overview line; the gate's `PAYMENT_REQUIRED` state and the wake reflex that feeds it; the
   low-hours strip; the site demo's `DEMO_HOSTED_PLAN` fixture (`_site/demo/src/platform.ts`) follows the shape.
4. **Slots** (one session): `quantity` and `stripeItemId` mirrored; `setSlots`; the provision gate and the offer
   read slots; the portal configured without subscription update; `_site/site-content/src/pricing.ts` says
   "$20 a month per hosted sandbox".

## 7. What this does not decide

- The price of a second slot (the same $20 is the honest default; a discount is a decision for when someone
  buys one).
- A bigger shape, annual billing, team billing. Each waits on an ask that has a name attached.
- `hosted.planMonthlyHours`. Step 2 makes it enforceable; the admin panel's top-owners table says whether it is
  ever needed.

## 8. The avatar row became a chip

The menu row §4 asked for shipped, and then the two surfaces it was standing in for shipped after it: the
low-hours strip above the composer (`ChatPaneNotices.vue`) and the wake refusal at the gate
(`connectionNotice.ts`). §4 listed all three as if they were four separate jobs. They were not. Two of them are
alarms in the reader's path; the third was an alarm behind a click, which is the one place an alarm cannot
work — a menu is only read by someone who already went looking, and that person was on their way to Billing
anyway.

The row was also the wrong shape for most of the people who had it. "Hosted plan · renews Oct 1" and "Hosted ·
complimentary" are not errands; they were links drawn like news, carrying no news, sitting in a menu whose other
rows are verbs (Settings, Sign out). The complaint that started this was exactly that: why is a comp a menu
item.

**Now:** `planBadge` (`hostedHours.ts`) returns a `<StatusBadge>` chip, not clickable, with the sentence on
hover. It is drawn on the two surfaces that state who this account is: inside the identity block of
`AccountPanel.vue` (under the name, `size="xs"`), and beside the display name on Settings ▸ Profile
(`SettingsProfile.vue`, the kit's default size, after the rename pencil rather than between the name and it).
Two places is not the duplication §8 is about: both are the account's identity, said once each, and neither
raises an alarm the reader has to act on from there. The row that went was an *alarm* in a menu.

| State | Chip | Tone |
| --- | --- | --- |
| Free lane | `free` | neutral |
| On the plan | `hosted` | primary |
| Trialing | `trial` | info |
| Cancelling | `ending` | warning |
| Comped | `complimentary` | info |
| `past_due` / `unpaid` / `incomplete` | `payment failed` | danger |
| Platform sells no plan | *(absent)* | — |

Two deliberate differences from the row. The chip **shows on a platform with no hour ceiling**, where the row
fell silent: with no hours there was no sentence to write, but "not on the plan" is a fact a chip states
happily. And a **failing card keeps its alarm here** rather than earning a strip of its own: it is what the
account *is* (on a plan nobody is paying for), not news about usage, it ends with the machine dropped to the
free lane, and Settings ▸ Billing is the row immediately beneath it.

Hours, renewal dates, machines and slots are Billing's alone. `hoursSpent` went with the row — the free lane's
tone was its only caller.
