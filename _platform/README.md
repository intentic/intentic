# Account

The hosted platform plane: sign-in, the web↔api contract, the database schema, and the capability
catalog. Deliberately off the command path: the editor talks to the sandbox directly, and this plane cannot
reach into anyone's box. Two configured-off-by-default exceptions: the optional free trial
([api/src/trial/](api/src/trial/)), which serves model turns on intentic's own keys so a new user can chat
before connecting an AI account (it grants no ability to reach a sandbox); and the **hosted lane**
([api/src/sandbox/hosted/](api/src/sandbox/hosted/)), which creates a sandbox's machine on intentic's own
provider account so a new user gets a working sandbox at first sign-in with no command: for those machines
the platform deliberately keeps the way back in (wake/stop/destroy), the trade ARCHITECTURE.md states in
full. Commands still never pass through here.

The one paid thing is a **bigger hosted machine** ([api/src/sandbox/hosted/hosted-plan.ts](api/src/sandbox/hosted/hosted-plan.ts)):
a Stripe subscription buying slots at a rung of the machine ladder (`@intentic/constants` hosted-tiers), each rung
its own shape, its own awake-hour ceiling and its own price. Slots are bought; which machine stands on one is a
separate act (`hostedPlan.changeTier`, which runs a migration), so a move that rolls back leaves a paid-for empty
slot rather than a charge with nothing behind it. Nothing else reads any of it: every feature is in the free
product, and money changes whose machine and how big, never what an agent can do
([docs/design/hosted-machines.md](../docs/design/hosted-machines.md),
[docs/design/pricing-model.md](../docs/design/pricing-model.md)). The editor's one page about it is
Settings ▸ Billing ([docs/design/billing-view.md](../docs/design/billing-view.md)).
