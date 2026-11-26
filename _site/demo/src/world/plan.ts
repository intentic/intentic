import type { HostedHoursMeter, HostedMigration, HostedPlanMachine, HostedPlanState } from "@intentic/api-contract";
import { FREE_TIER, HOSTED_TIER_IDS, hostedTier, isHostedTierId, PAID_TIERS } from "@intentic/constants";
import { demoMode, freshEdition } from "../mode";
import { cloudShown, DEMO_CLOUD_SANDBOXES, DEMO_HOSTED_PLAN } from "./account";
import { rowOf } from "./sandboxRegistry";

// THE ACCOUNT'S PLANS AS LIVE STATE (2026-11-26): every cloud sandbox is on Free, Standard or Max, all the paid ones on one
// subscription renewing on one date. Whether the account subscribes, the plan each machine of ours is on, a change waiting
// on one (a downgrade at renewal, or an upgrade being applied), the resize an upgrade restarts it with, and plans paid for
// that no sandbox is on. The Billing page's and the change dialog's writes land here (platform/billing.handler.ts), and
// so does a machine the platform provisions (platform/sandbox.handler.ts).
//
// Unlike the rest of the world it outlives a reload of the tab: checkout and the portal are Stripe's pages, which the
// browser LEAVES for, so the demo's "Stripe" applies the errand here at once and the page it sends the browser back to
// must still find it. A resize is a function of the time it started rather than of timers, for the same reason: a reload
// mid-restart finds it at the step it has reached. Kept per mode, so switching mode starts afresh.

const KEY = `intentic.demo.plans.${demoMode.id}`;
const DAY_MS = 86_400_000;
// Each step of a resize, held long enough to be seen on the Plan card: snapshot, resize, start.
const MOVE_STEP_MS = 5_000;
const MOVE_STEPS = [`snapshotting`, `applying`, `verifying`] as const;
// The renewal day of the demo's subscription, the 26th, as the screenshots the owner approved say it.
const RENEWAL_DAY = 26;

interface Move {
    toTier: string;
    startedAt: string;
    // The demo's one failed upgrade: the first resize to Max is put back, and "Try again" goes through.
    fails: boolean;
}

// What one tab remembers of the account's plans.
interface Held {
    onPlan: boolean;
    status?: string;
    renewsAt?: string;
    cancelAtPeriodEnd: boolean;
    // The plan each machine of ours is on, and the change waiting on it.
    tiers: Record<string, string>;
    changes: Record<string, { tier: string; at: string }>;
    moves: Record<string, Move>;
    // Paid plans no sandbox is on, by tier.
    seats: Record<string, number>;
    // When each machine woke, the minutes it spent before this page, and its week's memory kills.
    wokeAt: Record<string, string>;
    usedMinutes: Record<string, number>;
    ooms: Record<string, number>;
    failedOnce: boolean;
}

// The first of next month, UTC: when every month of hours rolls over.
const nextMonth = (): string => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
};

// The next renewal date: the coming 26th, so a visitor on any day sees a period they are in.
const nextRenewal = (): string => {
    const now = new Date();
    const month = now.getUTCDate() < RENEWAL_DAY ? now.getUTCMonth() : now.getUTCMonth() + 1;
    return new Date(Date.UTC(now.getUTCFullYear(), month, RENEWAL_DAY)).toISOString();
};

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

// The cloud sandboxes of the modes that show every state: one on Free short of hours, one on Standard, one on Max going
// down to Standard, and a Standard plan paid for that no sandbox is on yet (bought before plans belonged to sandboxes).
const cloudSeed = (): Held => ({
    onPlan: true,
    status: `active`,
    renewsAt: nextRenewal(),
    cancelAtPeriodEnd: false,
    tiers: Object.fromEntries(DEMO_CLOUD_SANDBOXES.map((seed) => [seed.id, seed.tier])),
    changes: Object.fromEntries(DEMO_CLOUD_SANDBOXES.flatMap((seed) => (seed.downTo === undefined ? [] : [[seed.id, { tier: seed.downTo, at: nextRenewal() }]]))),
    moves: {},
    seats: { standard: 1 },
    wokeAt: Object.fromEntries(DEMO_CLOUD_SANDBOXES.map((seed, index) => [seed.id, hoursAgo(index + 1)])),
    usedMinutes: Object.fromEntries(DEMO_CLOUD_SANDBOXES.map((seed) => [seed.id, seed.usedMinutes])),
    ooms: Object.fromEntries(DEMO_CLOUD_SANDBOXES.map((seed) => [seed.id, seed.ooms])),
    failedOnce: false,
});

// The seed: the paying account of every recording, or, on a sandbox's first day, an account with nothing paid.
const seeded = (): Held => {
    if (cloudShown) {
        return cloudSeed();
    }
    const machines = freshEdition ? [] : (DEMO_HOSTED_PLAN.hosted?.machines ?? []);
    const seed: Held = {
        onPlan: !freshEdition && DEMO_HOSTED_PLAN.onPlan,
        cancelAtPeriodEnd: false,
        tiers: Object.fromEntries(machines.map((machine) => [machine.sandboxId, machine.tier])),
        changes: {},
        moves: {},
        seats: {},
        wokeAt: Object.fromEntries(machines.flatMap((machine) => (machine.wokeAt === null ? [] : [[machine.sandboxId, machine.wokeAt]]))),
        usedMinutes: Object.fromEntries(machines.map((machine) => [machine.sandboxId, machine.hours.usedMinutes])),
        ooms: {},
        failedOnce: false,
    };
    if (!freshEdition) {
        seed.status = DEMO_HOSTED_PLAN.status;
        seed.renewsAt = nextRenewal();
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

// The rungs this demo's "Stripe" has a price for; the free one is never bought.
const ON_SALE = new Set(DEMO_HOSTED_PLAN.onSale ?? PAID_TIERS.map((tier) => tier.id));

const RANKS: ReadonlyMap<string, number> = new Map(HOSTED_TIER_IDS.map((id, index) => [id, index]));
const rank = (tier: string): number => RANKS.get(tier) ?? -1;
const priced = (tier: string): boolean => hostedTier(tier).priceUsd > 0;

// Every machine of ours the account still has: a row that is gone, or released, takes its machine with it.
const machineIds = (): string[] => Object.keys(held.tiers).filter((id) => rowOf(id) !== undefined);

/** Free sandboxes the account may still have: one, less the one on Free and any paid one going down to it. */
const freeLeft = (): number =>
    Math.max(0, 1 - machineIds().filter((id) => !priced(held.tiers[id] ?? FREE_TIER.id) || held.changes[id]?.tier === FREE_TIER.id).length);

const migrationOf = (move: Move, now: number): NonNullable<HostedPlanMachine[`migration`]> => {
    const step = Math.floor((now - Date.parse(move.startedAt)) / MOVE_STEP_MS);
    const base = { toTier: move.toTier, startedAt: move.startedAt };
    if (step < MOVE_STEPS.length) {
        return { ...base, state: MOVE_STEPS[Math.max(0, step)] ?? `planned` };
    }
    return move.fails
        ? { ...base, state: `rolledBack`, error: `The bigger machine did not pass its start check, so the sandbox was put back as it was.` }
        : { ...base, state: `done` };
};

/** A resize that has run its course lands: the machine is on its new plan and the change is no longer waiting. */
const settle = (now: number): void => {
    let landed = false;
    for (const [id, move] of Object.entries(held.moves)) {
        if (migrationOf(move, now).state === `done` && held.tiers[id] !== move.toTier) {
            held.tiers[id] = move.toTier;
            delete held.changes[id];
            // A new machine, whose week of memory kills starts at none.
            held.ooms[id] = 0;
            landed = true;
        }
    }
    if (landed) {
        save();
    }
};

const freeHoursMeter = (): HostedHoursMeter => ({
    kind: `free`,
    usedMinutes: machineIds()
        .filter((id) => !priced(held.tiers[id] ?? FREE_TIER.id) || !held.onPlan)
        .reduce((sum, id) => sum + (held.usedMinutes[id] ?? 0) + awakeMinutes(id), 0),
    allowanceMinutes: FREE_TIER.monthlyHours * 60,
    resetsAt: nextMonth(),
});

const awakeMinutes = (id: string): number => {
    const wokeAt = held.wokeAt[id];
    return wokeAt === undefined ? 0 : Math.floor((Date.now() - Date.parse(wokeAt)) / 60_000);
};

const machineOf = (sandboxId: string, now: number): HostedPlanMachine => {
    const tier = hostedTier(held.tiers[sandboxId] ?? FREE_TIER.id);
    const change = held.changes[sandboxId];
    // Paid this month: its own paid plan, or a bigger one an upgrade under way has already paid for.
    const upgrading = change !== undefined && Date.parse(change.at) <= now && rank(change.tier) > rank(tier.id);
    const paid = (tier.priceUsd > 0 || upgrading) && held.onPlan;
    const move = held.moves[sandboxId];
    const migration = move === undefined ? undefined : migrationOf(move, now);
    const machine: HostedPlanMachine = {
        sandboxId,
        name: rowOf(sandboxId)?.name ?? sandboxId,
        region: `arn`,
        wokeAt: held.wokeAt[sandboxId] ?? null,
        tier: tier.id,
        shape: tier,
        hours: tier.priceUsd > 0 && held.onPlan
            ? { kind: `slot`, usedMinutes: (held.usedMinutes[sandboxId] ?? 0) + awakeMinutes(sandboxId), allowanceMinutes: tier.monthlyHours * 60, resetsAt: nextMonth() }
            : freeHoursMeter(),
        oomsThisWeek: held.ooms[sandboxId] ?? 0,
        paid,
    };
    if (change !== undefined) {
        machine.change = change;
    }
    // A resize is reported while it runs, or once it ended unfinished; a finished one is simply the plan it landed on.
    if (migration !== undefined && migration.state !== `done`) {
        machine.migration = migration;
    }
    return machine;
};

/** hostedPlan.state: the plans as they stand now. */
export const planState = (): HostedPlanState => {
    const now = Date.now();
    settle(now);
    const machines = machineIds().map((id) => machineOf(id, now));
    const seats = Object.fromEntries(Object.entries(held.seats).filter(([, count]) => count > 0));
    const state: HostedPlanState = {
        enabled: true,
        onPlan: held.onPlan,
        priceUsd: DEMO_HOSTED_PLAN.priceUsd,
        onSale: [...ON_SALE],
        hosted: {
            // The earlier editors' slot count: every plan held, on a sandbox or not.
            slots: machines.length + Object.values(seats).reduce((sum, count) => sum + count, 0),
            slotsByTier: Object.fromEntries(HOSTED_TIER_IDS.map((tier) => [tier, machines.filter((machine) => machine.tier === tier).length + (seats[tier] ?? 0)])),
            machines,
            freeHours: freeHoursMeter(),
            freeTier: { id: FREE_TIER.id, shape: FREE_TIER, monthlyHours: FREE_TIER.monthlyHours },
            openSeats: seats,
            freeLeft: freeLeft(),
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

/** Why a plan cannot be bought here, or undefined for one on sale. */
export const notOnSale = (tier: string): string | undefined =>
    !isHostedTierId(tier) ? `There is no plan called ${tier}.` : ON_SALE.has(tier) ? undefined : `${hostedTier(tier).name} is not something this platform sells.`;

export const subscribed = (): boolean => held.onPlan;

/** Whether the account has anything for the portal to manage: a subscription now or before. */
export const hasSubscription = (): boolean => held.status !== undefined;

/** The machine of ours on this sandbox, and the plan it is on; undefined for a sandbox that runs elsewhere. */
export const machineTier = (sandboxId: string): string | undefined => (machineIds().includes(sandboxId) ? held.tiers[sandboxId] : undefined);

// The machine restarts onto `tier`'s size: snapshot, resize, start, each a few seconds (migrationOf).
const startMove = (sandboxId: string, tier: string): void => {
    const now = new Date().toISOString();
    const fails = tier === `max` && !held.failedOnce;
    held.failedOnce = held.failedOnce || fails;
    held.changes[sandboxId] = { tier, at: now };
    held.moves[sandboxId] = { toTier: tier, startedAt: now, fails };
};

/**
 * checkout: the first purchase, paid the moment it is asked for. With a sandbox named, that sandbox is upgraded as the
 * payment lands; without one, the plan waits for the new sandbox Stripe sends the browser back to make.
 */
export const subscribe = (tier: string, sandboxId: string | undefined): void => {
    held.onPlan = true;
    held.status = `active`;
    held.renewsAt = new Date(Date.now() + 30 * DAY_MS).toISOString();
    held.cancelAtPeriodEnd = false;
    if (sandboxId !== undefined && machineIds().includes(sandboxId)) {
        startMove(sandboxId, tier);
    } else {
        held.seats[tier] = (held.seats[tier] ?? 0) + 1;
    }
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

/** The other sandbox on Free, named where a second one is refused. */
const freeHolderName = (except: string): string =>
    rowOf(machineIds().find((id) => id !== except && (!priced(held.tiers[id] ?? FREE_TIER.id) || held.changes[id]?.tier === FREE_TIER.id)) ?? ``)?.name ?? `another sandbox`;

/**
 * changePlan: up is paid now and restarts the machine; down waits for the renewal date; its own plan withdraws a change
 * waiting; a due change's plan again retries a resize that did not finish. The refusal, in words, when it cannot.
 */
export const changePlan = (sandboxId: string, tier: string): string | undefined => {
    const current = held.tiers[sandboxId] ?? FREE_TIER.id;
    const change = held.changes[sandboxId];
    const due = change !== undefined && Date.parse(change.at) <= Date.now();
    if (tier === current) {
        if (change === undefined || due) {
            return `This sandbox is already on ${hostedTier(tier).name}.`;
        }
        delete held.changes[sandboxId];
    } else if (due && change.tier === tier) {
        startMove(sandboxId, tier);
    } else if (!priced(tier) && freeLeft() === 0 && priced(current) && held.changes[sandboxId]?.tier !== tier) {
        return `${freeHolderName(sandboxId)} is your Free sandbox; an account has one.`;
    } else if (rank(tier) > rank(current)) {
        if ((held.seats[tier] ?? 0) > 0) {
            held.seats[tier] = (held.seats[tier] ?? 0) - 1;
        }
        startMove(sandboxId, tier);
    } else {
        held.changes[sandboxId] = { tier, at: held.renewsAt ?? nextRenewal() };
    }
    save();
    return undefined;
};

/** reserve: a plan at `tier` for a sandbox about to be made, an open one reused, else one added. */
export const reserve = (tier: string): void => {
    held.seats[tier] = Math.max(1, held.seats[tier] ?? 0);
    save();
};

/** release: one plan no sandbox is on ends at renewal; the demo stops showing it at once. */
export const release = (tier: string): string | undefined => {
    if ((held.seats[tier] ?? 0) <= 0) {
        return `No ${hostedTier(tier).name} plan is waiting for a sandbox.`;
    }
    held.seats[tier] = (held.seats[tier] ?? 0) - 1;
    save();
    return undefined;
};

/** setSlots, as an earlier editor sends it: the plans held at a rung, less those sandboxes are on, are its open ones. */
export const setSlots = (tier: string, quantity: number): string | undefined => {
    const using = machineIds().filter((id) => held.tiers[id] === tier).length;
    if (quantity < using) {
        return `${using} of your sandboxes are on ${hostedTier(tier).name}; move one to another plan first.`;
    }
    held.seats[tier] = quantity - using;
    save();
    return undefined;
};

/** changeTier, as an earlier editor sends it: the resize starts, and its first step is the answer. */
export const moveMachine = (sandboxId: string, tier: string): HostedMigration => {
    const fromTier = held.tiers[sandboxId] ?? FREE_TIER.id;
    startMove(sandboxId, tier);
    save();
    return { id: `mig-${Date.now().toString(36)}`, sandboxId, kind: `resize`, state: `planned`, fromTier, toTier: tier, startedAt: new Date().toISOString() };
};

/** Whether a machine at `tier` can be provisioned now: a Free one left, or a paid plan waiting for a sandbox. */
export const provisionRefusal = (tier: string): string | undefined => {
    if (!priced(tier)) {
        return freeLeft() > 0 ? undefined : `Your Free sandbox is already in use. Pick Standard or Max, or run this sandbox on your own computer.`;
    }
    return (held.seats[tier] ?? 0) > 0 ? undefined : `There is no ${hostedTier(tier).name} plan for a new sandbox yet.`;
};

/** How many machines of ours at `tier` the account may start now. */
export const startableAt = (tier: string): number => (priced(tier) ? (held.seats[tier] ?? 0) : freeLeft());

/** A machine of ours now stands on this plan (a provision placed it there), taking the open plan it was made for. */
export const placeMachine = (sandboxId: string, tier: string): void => {
    if (priced(tier)) {
        held.seats[tier] = Math.max(0, (held.seats[tier] ?? 0) - 1);
    }
    held.tiers[sandboxId] = tier;
    held.wokeAt[sandboxId] = new Date().toISOString();
    save();
};

/** The machine went back to the pool: its plan ends with it. */
export const dropMachine = (sandboxId: string): void => {
    delete held.tiers[sandboxId];
    delete held.wokeAt[sandboxId];
    delete held.changes[sandboxId];
    delete held.moves[sandboxId];
    save();
};
