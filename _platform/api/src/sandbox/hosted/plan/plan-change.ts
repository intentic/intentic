import { HOSTED_PLAN_MAX_SLOTS } from "@intentic/api-contract";
import { FREE_TIER, hostedTier, isHostedTierId } from "@intentic/constants";

/* EVERY CLOUD SANDBOX HAS A PLAN (2026-11-26). What a change of plan does, decided here and nowhere else, as pure
 * functions the routes, the webhook and the job carry out (hosted-plan.orpc.ts, hosted-plan-changes.ts).
 *
 * The machine row is the ledger: `paid` says a sandbox's plan is paid for, `planTo`/`planAt` a change waiting. The one
 * Stripe subscription per account carries a quantity per paid tier, and that quantity always says what the NEXT invoice
 * bills: every sandbox whose plan will be paid at that tier next month, plus any plan the account pays for that no
 * sandbox is on ("open"). Up is immediate and prorated: the quantity rises now and Stripe adds the rest of the month to
 * the next bill. Down waits for the renewal date: the quantity falls now with no proration, so the next invoice is the
 * smaller one, and the sandbox keeps its paid size (and its `paid`) until the job applies the change. When nothing paid
 * would be left, the subscription is set to end at the renewal date instead, since Stripe is never asked to hold an item
 * at quantity zero; its quantities then mean nothing, and nothing reads them while it is ending.
 * (Rejected: one subscription per sandbox, which bills N times a month on N dates and leaves the Stripe portal listing
 * "Standard, Standard, Max" with no names to cancel by.) */

/** One cloud sandbox as its plan sees it. */
export interface PlanMachine {
    readonly sandboxId: string;
    readonly name: string;
    readonly tier: string;
    readonly paid: boolean;
    readonly planTo: string | null;
    readonly planAt: Date | null;
}

/** The owner's billing, as much of it as a change of plan reads. */
export interface PlanAccount {
    // A subscription Stripe still bills (active, trialing, or retrying a charge); absent for none or one that has ended.
    readonly subscription?: {
        // Paid up (active or trialing); false while Stripe retries a failed charge.
        readonly active: boolean;
        readonly periodEnd: Date;
        readonly cancelAtPeriodEnd: boolean;
        // The next invoice's quantity at each paid tier, as mirrored from Stripe.
        readonly quantities: ReadonlyMap<string, number>;
    };
    // On the operator's comp list with no subscription: unlimited hours, every change applied at once and never billed.
    readonly comped: boolean;
    // How many free sandboxes one account may have (`hosted.perUser`).
    readonly freeAllowed: number;
    // The paid tiers this platform has a Stripe price for.
    readonly onSale: ReadonlySet<string>;
}

export type Proration = `create_prorations` | `none`;

/** One write to the subscription: the next invoice's quantity at every tier it touches. All zero ends it at renewal. */
export interface SeatWrite {
    readonly quantities: ReadonlyMap<string, number>;
    readonly proration: Proration;
}

export type PlanRefusal = `unknown-tier` | `not-on-sale` | `nothing-to-do` | `checkout` | `card` | `free-taken` | `too-many`;

export type PlanDecision =
    | { readonly kind: `refused`; readonly code: PlanRefusal; readonly message: string }
    | {
          readonly kind: `change`;
          // In order; a withdrawn change is written before the new one, so each is prorated by its own rule.
          readonly writes: readonly SeatWrite[];
          // What the sandbox's row becomes once the writes are made.
          readonly machine: { readonly paid: boolean; readonly planTo: string | null; readonly planAt: Date | null };
          // Whether its machine is resized now (in the background); false when the change waits for the renewal date.
          readonly resize: boolean;
      };

const priceOf = (tier: string): number => (isHostedTierId(tier) ? hostedTier(tier).priceUsd : 0);
const nameOf = (tier: string): string => (isHostedTierId(tier) ? hostedTier(tier).name : tier);

export const isPaidTier = (tier: string): boolean => priceOf(tier) > 0;

/** The tier a sandbox is on next month: the change waiting, else where it stands. */
export const nextTierOf = (machine: Pick<PlanMachine, "tier" | "planTo">): string => machine.planTo ?? machine.tier;

/** The paid tier this sandbox's plan bills next month, or undefined where nothing of it is billed. */
export const nextSeatOf = (machine: Pick<PlanMachine, "tier" | "planTo" | "paid">): string | undefined => {
    const next = nextTierOf(machine);
    return machine.paid && isPaidTier(next) ? next : undefined;
};

const countBy = (tiers: readonly (string | undefined)[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const tier of tiers) {
        if (tier !== undefined) {
            counts.set(tier, (counts.get(tier) ?? 0) + 1);
        }
    }
    return counts;
};

/** Every paid plan the subscription bills next month that no sandbox is on, by tier; none while it is ending. */
export const openSeatsOf = (account: PlanAccount, machines: readonly PlanMachine[]): Map<string, number> => {
    const open = new Map<string, number>();
    const subscription = account.subscription;
    if (subscription === undefined || subscription.cancelAtPeriodEnd) {
        return open;
    }
    const held = countBy(machines.map(nextSeatOf));
    for (const [tier, quantity] of subscription.quantities) {
        const left = quantity - (held.get(tier) ?? 0);
        if (left > 0 && isPaidTier(tier)) {
            open.set(tier, left);
        }
    }
    return open;
};

/** The sandboxes that are, or are about to be, this account's free ones. */
const freeOnes = (machines: readonly PlanMachine[], except?: string): PlanMachine[] =>
    machines.filter((machine) => machine.sandboxId !== except && nextTierOf(machine) === FREE_TIER.id);

/** Free sandboxes this account can still have, counting one scheduled to become free. */
export const freeLeftOf = (account: Pick<PlanAccount, "freeAllowed">, machines: readonly PlanMachine[], except?: string): number =>
    Math.max(0, account.freeAllowed - freeOnes(machines, except).length);

/**
 * Whether this machine's own hours are its plan's right now: on a paid tier, paid for on a subscription that is paid up,
 * and not past the date of a downgrade still waiting for its machine (from then on it is not paid for at this size).
 */
export const onPaidPlan = (machine: Pick<PlanMachine, "tier" | "paid" | "planTo" | "planAt">, active: boolean, now: Date): boolean =>
    active &&
    machine.paid &&
    isPaidTier(machine.tier) &&
    !(machine.planTo !== null && machine.planAt !== null && machine.planAt <= now && priceOf(machine.planTo) < priceOf(machine.tier));

const refused = (code: PlanRefusal, message: string): PlanDecision => ({ kind: `refused`, code, message });

const sumOf = (quantities: ReadonlyMap<string, number>): number => [...quantities.values()].reduce((sum, count) => sum + count, 0);

/**
 * The write that bills `after` next month: each sandbox's own next seat, the open plans `before` had, less one where
 * `consume` takes it. Undefined when the subscription already says exactly that.
 */
const seatWrite = (
    account: PlanAccount,
    before: readonly PlanMachine[],
    after: readonly PlanMachine[],
    proration: Proration,
    consume?: string,
): SeatWrite | undefined => {
    const subscription = account.subscription;
    if (subscription === undefined) {
        return undefined;
    }
    const open = openSeatsOf(account, before);
    if (consume !== undefined) {
        open.set(consume, Math.max(0, (open.get(consume) ?? 0) - 1));
    }
    const held = countBy(after.map(nextSeatOf));
    const quantities = new Map<string, number>();
    for (const tier of new Set([...subscription.quantities.keys(), ...held.keys(), ...open.keys()])) {
        if (isPaidTier(tier)) {
            quantities.set(tier, (held.get(tier) ?? 0) + (open.get(tier) ?? 0));
        }
    }
    const ending = sumOf(quantities) === 0;
    if (ending) {
        return subscription.cancelAtPeriodEnd ? undefined : { quantities, proration };
    }
    const unchanged = !subscription.cancelAtPeriodEnd && [...quantities].every(([tier, count]) => (subscription.quantities.get(tier) ?? 0) === count);
    return unchanged ? undefined : { quantities, proration };
};

/** The account as it stands once a write has been made, so a second write reads the first one's outcome. */
const afterWrite = (account: PlanAccount, write: SeatWrite | undefined): PlanAccount => {
    if (write === undefined || account.subscription === undefined) {
        return account;
    }
    const ending = sumOf(write.quantities) === 0;
    return {
        ...account,
        subscription: {
            ...account.subscription,
            cancelAtPeriodEnd: ending,
            quantities: ending ? account.subscription.quantities : write.quantities,
        },
    };
};

const tooMany = (write: SeatWrite | undefined): string | undefined => {
    const over = write === undefined ? undefined : [...write.quantities].find(([, count]) => count > HOSTED_PLAN_MAX_SLOTS);
    return over === undefined ? undefined : `one account holds at most ${HOSTED_PLAN_MAX_SLOTS} sandboxes on ${nameOf(over[0])}`;
};

const replace = (machines: readonly PlanMachine[], next: PlanMachine): PlanMachine[] =>
    machines.map((machine) => (machine.sandboxId === next.sandboxId ? next : machine));

const written = (...writes: (SeatWrite | undefined)[]): SeatWrite[] => writes.filter((write): write is SeatWrite => write !== undefined);

/**
 * The waiting change taken back, as its own write. Before its date nothing is prorated: a downgrade withdrawn early was
 * paid for all along. Once due, it is: an upgrade not yet applied is credited, a downgrade the renewal already billed
 * is charged for the rest of the month it is kept.
 */
const withdraw = (account: PlanAccount, machines: readonly PlanMachine[], machine: PlanMachine, now: Date) => {
    const due = machine.planAt === null || machine.planAt <= now;
    const wasUpgrade = machine.planTo !== null && priceOf(machine.planTo) > priceOf(machine.tier);
    // An upgrade still being applied made the sandbox paid; taken back, it is paid only where it already stood on one.
    const restored: PlanMachine = { ...machine, planTo: null, planAt: null, paid: wasUpgrade ? isPaidTier(machine.tier) && machine.paid : machine.paid };
    const after = replace(machines, restored);
    const write = seatWrite(account, machines, after, due ? `create_prorations` : `none`);
    return { restored, after, write };
};

// The epoch stands for "now" inside the pure branches, stamped by `at` below, so none of them reads a clock.
const NOW_MARK = new Date(0);

/** Up, or a lapsed paid-size sandbox put back on its own plan: a subscriber's, billed from now. */
const freshUp = (account: PlanAccount, machines: readonly PlanMachine[], machine: PlanMachine, target: string): PlanDecision => {
    const subscription = account.subscription;
    if (subscription === undefined) {
        return refused(`checkout`, `pay for the first plan on Stripe's page`);
    }
    if (!subscription.active) {
        return refused(`card`, `the last payment did not go through; update the card before adding a plan`);
    }
    const renew = target === machine.tier;
    const open = openSeatsOf(account, machines).get(target) ?? 0;
    const next: PlanMachine = { ...machine, paid: true, planTo: renew ? null : target, planAt: renew ? null : NOW_MARK };
    const write = seatWrite(account, machines, replace(machines, next), `create_prorations`, open > 0 ? target : undefined);
    const over = tooMany(write);
    return over === undefined
        ? { kind: `change`, writes: written(write), machine: { paid: true, planTo: next.planTo, planAt: next.planAt }, resize: !renew }
        : refused(`too-many`, over);
};

/** Down: from the renewal date while a subscription bills this sandbox, otherwise now, since nothing is paid to wait out. */
const freshDown = (account: PlanAccount, machines: readonly PlanMachine[], machine: PlanMachine, target: string): PlanDecision => {
    const subscription = account.subscription;
    if (subscription === undefined || !machine.paid) {
        return { kind: `change`, writes: [], machine: { paid: machine.paid && isPaidTier(target), planTo: target, planAt: NOW_MARK }, resize: true };
    }
    const next: PlanMachine = { ...machine, planTo: target, planAt: subscription.periodEnd };
    const write = seatWrite(account, machines, replace(machines, next), `none`);
    return { kind: `change`, writes: written(write), machine: { paid: true, planTo: target, planAt: subscription.periodEnd }, resize: false };
};

/** A change to `target` for a sandbox with no change waiting. */
const fresh = (account: PlanAccount, machines: readonly PlanMachine[], machine: PlanMachine, target: string): PlanDecision => {
    const renew = target === machine.tier;
    if (renew && (machine.paid || !isPaidTier(target) || account.comped)) {
        return refused(`nothing-to-do`, `this sandbox is already on ${nameOf(target)}`);
    }
    // Comped: nothing is billed, so nothing waits for a renewal date either.
    if (account.comped && account.subscription === undefined) {
        return { kind: `change`, writes: [], machine: { paid: false, planTo: target, planAt: NOW_MARK }, resize: true };
    }
    return renew || priceOf(target) > priceOf(machine.tier) ? freshUp(account, machines, machine, target) : freshDown(account, machines, machine, target);
};

/* Stamps "now" over the placeholder. */
const at = (decision: PlanDecision, now: Date): PlanDecision =>
    decision.kind === `change` && decision.machine.planAt?.getTime() === NOW_MARK.getTime() ? { ...decision, machine: { ...decision.machine, planAt: now } } : decision;

/**
 * WHAT PUTTING ONE SANDBOX ON `target` DOES. Its own tier while a change waits takes the change back; the tier of a
 * change already due tries it again without billing anything twice; anything else first takes back what was waiting,
 * so a scheduled downgrade withdrawn is never billed as an upgrade, then applies the new change.
 */
export const decidePlanChange = (account: PlanAccount, machines: readonly PlanMachine[], sandboxId: string, target: string, now: Date): PlanDecision => {
    const machine = machines.find((row) => row.sandboxId === sandboxId);
    if (machine === undefined) {
        return refused(`nothing-to-do`, `you have no cloud sandbox by that id`);
    }
    if (!isHostedTierId(target)) {
        return refused(`unknown-tier`, `there is no plan called ${target}`);
    }
    if (isPaidTier(target) && !account.onSale.has(target) && target !== machine.tier) {
        return refused(`not-on-sale`, `${nameOf(target)} is not sold on this platform`);
    }
    if (target === FREE_TIER.id && nextTierOf(machine) !== FREE_TIER.id && freeLeftOf(account, machines, sandboxId) === 0) {
        const holder = freeOnes(machines, sandboxId)[0];
        return refused(`free-taken`, holder === undefined ? `this account has no free sandbox left` : `${holder.name} is this account's free sandbox`);
    }
    if (machine.planTo === null) {
        return at(fresh(account, machines, machine, target), now);
    }
    // The change already waiting, asked for again.
    if (target === machine.planTo) {
        const due = machine.planAt === null || machine.planAt <= now;
        return due
            ? { kind: `change`, writes: [], machine: { paid: machine.paid, planTo: machine.planTo, planAt: machine.planAt }, resize: true }
            : refused(`nothing-to-do`, `this sandbox already moves to ${nameOf(target)} on the renewal date`);
    }
    const { restored, after, write } = withdraw(account, machines, machine, now);
    if (target === machine.tier && (restored.paid || !isPaidTier(target))) {
        return { kind: `change`, writes: written(write), machine: { paid: restored.paid, planTo: null, planAt: null }, resize: false };
    }
    const then = at(fresh(afterWrite(account, write), after, restored, target), now);
    return then.kind === `refused` ? then : { ...then, writes: [...written(write), ...then.writes] };
};

/** A plan for a sandbox about to be made at `tier`: an open one reused, else one more, paid for the rest of the month. */
export const decideReserve = (account: PlanAccount, machines: readonly PlanMachine[], tier: string): PlanDecision => {
    if (!isPaidTier(tier)) {
        return refused(`unknown-tier`, `there is no paid plan called ${tier}`);
    }
    if (!account.onSale.has(tier)) {
        return refused(`not-on-sale`, `${nameOf(tier)} is not sold on this platform`);
    }
    const subscription = account.subscription;
    const none = { paid: false, planTo: null, planAt: null };
    // Comped: nothing is billed, and the plans are the operator's to give (hosted-plan.ts hostedSlotsOf).
    if (account.comped && subscription === undefined) {
        return { kind: `change`, writes: [], machine: none, resize: false };
    }
    if (subscription === undefined) {
        return refused(`checkout`, `pay for the first plan on Stripe's page`);
    }
    if (!subscription.active) {
        return refused(`card`, `the last payment did not go through; update the card before adding a plan`);
    }
    if ((openSeatsOf(account, machines).get(tier) ?? 0) > 0) {
        return { kind: `change`, writes: [], machine: none, resize: false };
    }
    const placeholder: PlanMachine = { sandboxId: `\u0000reserved`, name: ``, tier, paid: true, planTo: null, planAt: null };
    const write = seatWrite(account, machines, [...machines, placeholder], `create_prorations`);
    const over = tooMany(write);
    return over === undefined ? { kind: `change`, writes: written(write), machine: none, resize: false } : refused(`too-many`, over);
};

/** One open plan at `tier` ended at the renewal date: the next invoice bills one fewer, nothing is credited now. */
export const decideRelease = (account: PlanAccount, machines: readonly PlanMachine[], tier: string): PlanDecision => {
    if ((openSeatsOf(account, machines).get(tier) ?? 0) === 0 || account.subscription === undefined) {
        return refused(`nothing-to-do`, `no ${nameOf(tier)} plan here is free of a sandbox`);
    }
    const quantities = new Map(account.subscription.quantities);
    quantities.set(tier, (quantities.get(tier) ?? 0) - 1);
    return { kind: `change`, writes: [{ quantities, proration: `none` }], machine: { paid: false, planTo: null, planAt: null }, resize: false };
};
