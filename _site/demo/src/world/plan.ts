import type { HostedHoursMeter, HostedMigration, HostedPlanMachine, HostedPlanState } from "@intentic/api-contract";
import { FREE_TIER, hostedTier, isHostedTierId, PAID_TIERS } from "@intentic/constants";
import { demoMode, freshEdition } from "../mode";
import { DEMO_HOSTED_PLAN } from "./account";
import { placeHosted, rowOf } from "./sandboxRegistry";

// THE ACCOUNT'S HOSTED PLAN AS LIVE STATE: whether it subscribes, the slots it holds at each rung and the rung each
// machine of ours stands on. The Billing page's writes land here (platform/billing.handler.ts), and so does a machine the
// platform provisions (platform/sandbox.ts). Unlike the rest of the world it outlives a reload of the tab: checkout and
// the portal are Stripe's pages, which the browser LEAVES for, so the demo's "Stripe" applies the errand here at once
// and the Billing page it sends the browser back to must still find it. Kept per mode, so switching mode starts afresh.

const KEY = `intentic.demo.plan.${demoMode.id}`;
const DAY_MS = 86_400_000;

// What one tab remembers of the plan: the subscription and its slots, and which rung each machine stands on.
interface Held {
    onPlan: boolean;
    status?: string;
    renewsAt?: string;
    cancelAtPeriodEnd: boolean;
    slotsByTier: Record<string, number>;
    tiers: Record<string, string>;
    // When each machine of ours woke, and the minutes it spent from its slot before this page (the seed's machine).
    wokeAt: Record<string, string>;
    usedMinutes: Record<string, number>;
}

// The first of next month, UTC: when every month of hours rolls over.
const nextMonth = (): string => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
};

// The seed: the paying account of every recording, or, on a sandbox's first day, an account on the free trial only.
const seeded = (): Held => {
    const hosted = DEMO_HOSTED_PLAN.hosted;
    const machines = freshEdition ? [] : (hosted?.machines ?? []);
    const seed: Held = {
        onPlan: !freshEdition && DEMO_HOSTED_PLAN.onPlan,
        cancelAtPeriodEnd: false,
        slotsByTier: freshEdition ? { [FREE_TIER.id]: 1 } : { ...hosted?.slotsByTier },
        tiers: Object.fromEntries(machines.map((machine) => [machine.sandboxId, machine.tier])),
        wokeAt: Object.fromEntries(machines.flatMap((machine) => (machine.wokeAt === null ? [] : [[machine.sandboxId, machine.wokeAt]]))),
        usedMinutes: Object.fromEntries(machines.map((machine) => [machine.sandboxId, machine.hours.usedMinutes])),
    };
    if (!freshEdition) {
        seed.status = DEMO_HOSTED_PLAN.status;
        // The period the visitor is in, whenever they visit: a seed's fixed date would soon read as one long past.
        seed.renewsAt = nextMonth();
    }
    return seed;
};

const load = (): Held => {
    const saved = sessionStorage.getItem(KEY);
    try {
        // SAFETY: only `save` below writes this key, from a `Held`.
        return saved === null ? seeded() : (JSON.parse(saved) as Held);
    } catch {
        // allow(silent-catch): a value that no longer parses is a plan to start again from the seed.
        return seeded();
    }
};

const held: Held = load();
const save = (): void => sessionStorage.setItem(KEY, JSON.stringify(held));

const freeHoursMeter = (): HostedHoursMeter => ({
    kind: `free`,
    usedMinutes: 0,
    allowanceMinutes: FREE_TIER.monthlyHours * 60,
    resetsAt: nextMonth(),
});

// The rungs this demo's "Stripe" has a price for; the free one is the lane, never bought.
const ON_SALE = new Set(DEMO_HOSTED_PLAN.onSale ?? PAID_TIERS.map((tier) => tier.id));

// Every machine of ours the account still has: a row that is gone, or released, takes its machine with it.
const machineIds = (): string[] => Object.keys(held.tiers).filter((id) => rowOf(id) !== undefined);

const machineOf = (sandboxId: string): HostedPlanMachine => {
    const tier = hostedTier(held.tiers[sandboxId] ?? FREE_TIER.id);
    const wokeAt = held.wokeAt[sandboxId] ?? null;
    const paid = tier.priceUsd > 0;
    const awake = wokeAt === null ? 0 : Math.floor((Date.now() - Date.parse(wokeAt)) / 60_000);
    return {
        sandboxId,
        name: rowOf(sandboxId)?.name ?? sandboxId,
        region: `arn`,
        wokeAt,
        tier: tier.id,
        shape: tier,
        hours: paid
            ? { kind: `slot`, usedMinutes: (held.usedMinutes[sandboxId] ?? 0) + awake, allowanceMinutes: tier.monthlyHours * 60, resetsAt: nextMonth() }
            : { ...freeHoursMeter(), usedMinutes: awake },
        oomsThisWeek: 0,
    };
};

/** hostedPlan.state: the plan as it stands now. */
export const planState = (): HostedPlanState => {
    const slots = Object.values(held.slotsByTier).reduce((sum, count) => sum + count, 0);
    const state: HostedPlanState = {
        enabled: true,
        onPlan: held.onPlan,
        priceUsd: DEMO_HOSTED_PLAN.priceUsd,
        onSale: [...ON_SALE],
        hosted: {
            slots,
            slotsByTier: { ...held.slotsByTier },
            machines: machineIds().map(machineOf),
            freeHours: freeHoursMeter(),
            freeTier: { id: FREE_TIER.id, shape: FREE_TIER, monthlyHours: FREE_TIER.monthlyHours },
        },
    };
    // Absent rather than empty, as the platform answers: a never-subscriber has no status and no period.
    if (held.status !== undefined) {
        state.status = held.status;
    }
    if (held.renewsAt !== undefined) {
        state.renewsAt = held.renewsAt;
    }
    if (held.cancelAtPeriodEnd) {
        state.cancelAtPeriodEnd = true;
    }
    return state;
};

/** How many machines stand on a rung, leaving one sandbox out (the one about to move off it). */
const standing = (tier: string, except?: string): number => machineIds().filter((id) => id !== except && held.tiers[id] === tier).length;

/** Slots at a rung no machine stands on yet. */
export const slotsLeftAt = (tier: string, except?: string): number => (held.slotsByTier[tier] ?? 0) - standing(tier, except);

/** Slots at any rung no machine stands on: how many more machines of ours the account may start. */
export const slotsLeft = (): number => Object.keys(held.slotsByTier).reduce((sum, tier) => sum + Math.max(0, slotsLeftAt(tier)), 0);

/** Why a rung cannot be bought here, or undefined for one on sale. */
export const notOnSale = (tier: string): string | undefined =>
    !isHostedTierId(tier) ? `There is no machine called ${tier}.` : ON_SALE.has(tier) ? undefined : `${hostedTier(tier).name} is not something this platform sells slots at.`;

/** The checkout paid: the account subscribes with one slot at the rung it picked, renewing a month from now. */
export const subscribe = (tier: string): void => {
    held.onPlan = true;
    held.status = `active`;
    held.renewsAt = new Date(Date.now() + 30 * DAY_MS).toISOString();
    held.cancelAtPeriodEnd = false;
    held.slotsByTier = { [FREE_TIER.id]: held.slotsByTier[FREE_TIER.id] ?? 1, [tier]: Math.max(1, held.slotsByTier[tier] ?? 0) };
    save();
};

/**
 * The portal's errand, as the one a visitor most likely went there for: a plan ending at the period's end is resumed,
 * a lapsed card is replaced, and an ordinary plan is cancelled at the end of its period (the page then says so and
 * offers to resume, which is the same door).
 */
export const managePlan = (): void => {
    if (!held.onPlan) {
        held.onPlan = true;
        held.status = `active`;
    } else {
        held.cancelAtPeriodEnd = !held.cancelAtPeriodEnd;
    }
    save();
};

/** Whether the account has anything for the portal to manage: a subscription now or before. */
export const hasSubscription = (): boolean => held.status !== undefined;

export const subscribed = (): boolean => held.onPlan;

/** setSlots: the rung's slots, refused below the machines already standing on them. */
export const setSlots = (tier: string, quantity: number): string | undefined => {
    const using = standing(tier);
    if (quantity < using) {
        return `${using} of your sandboxes are on ${hostedTier(tier).name}; move one down a rung before giving up its slot.`;
    }
    held.slotsByTier[tier] = quantity;
    save();
    return undefined;
};

/** A machine of ours now stands on this rung (a provision placed it there). */
export const placeMachine = (sandboxId: string, tier: string): void => {
    held.tiers[sandboxId] = tier;
    held.wokeAt[sandboxId] = new Date().toISOString();
    save();
};

/** The machine went back to the pool: its slot is free again. */
export const dropMachine = (sandboxId: string): void => {
    delete held.tiers[sandboxId];
    delete held.wokeAt[sandboxId];
    save();
};

export const machineTier = (sandboxId: string): string | undefined => (machineIds().includes(sandboxId) ? held.tiers[sandboxId] : undefined);

// The steps a move walks, each held long enough to be seen in the page's meter.
const MOVE_STEPS: readonly HostedMigration[`state`][] = [`snapshotting`, `applying`, `verifying`];
const MOVE_STEP_MS = 2_500;
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * changeTier: the machine is snapshotted, restarted on the new rung's shape and checked, and the one request answers
 * once that is over, as the platform's does. The row reads as starting while it moves, so every view of the sandbox
 * sees the restart.
 */
export const moveMachine = async (sandboxId: string, tier: string): Promise<HostedMigration> => {
    const fromTier = held.tiers[sandboxId] ?? FREE_TIER.id;
    const startedAt = new Date().toISOString();
    const hosted = rowOf(sandboxId)?.hosted ?? null;
    for (let step = 0; step < MOVE_STEPS.length; step += 1) {
        if (hosted !== null) {
            placeHosted(sandboxId, { ...hosted, state: `starting` });
        }
        await wait(MOVE_STEP_MS);
    }
    held.tiers[sandboxId] = tier;
    save();
    if (hosted !== null) {
        placeHosted(sandboxId, { ...hosted, state: `awake` });
    }
    return {
        id: `mig-${Date.now().toString(36)}`,
        sandboxId,
        kind: `resize`,
        state: `done`,
        fromTier,
        toTier: tier,
        startedAt,
        finishedAt: new Date().toISOString(),
    };
};
