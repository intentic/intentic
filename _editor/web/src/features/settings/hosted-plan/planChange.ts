import type { HostedPlanMachine, HostedPlanState } from "@intentic/api-contract";
import { formatCount, formatMoney } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import { formatDayShort, hoursMeter, RECOVERABLE } from "../../../models/hosted-plan/hostedHours";
import { isUpgrade, type MoveStep, type PlanMove, planMove } from "../../../models/hosted-plan/planMoves";
import { nextRung, type Rung, rungOf, sizeOf } from "./planLadder";

/* WHAT A CLOUD SANDBOX'S PLAN WOULD DO IF CHANGED, in the four words a person meets about money (2026-11-26): a sandbox,
 * its plan, its awake hours, and the bill. Every sandbox is on Free, Standard or Max; upgrading starts now (the rest of
 * the month is added to the next bill, and the sandbox restarts once); downgrading waits for the renewal date and keeps
 * its disk; every paid sandbox is on one monthly bill. Pure, so the sentences the Plan card, Billing's rows, the change
 * dialog and the new sandbox's picker say are pinned by tests rather than screenshots. */

/** Whether this sandbox's plan is paid this month: the platform's word, else (an older platform) a month of hours of its own. */
export const planPaid = (machine: Pick<HostedPlanMachine, `paid` | `hours`>): boolean => machine.paid ?? machine.hours.kind === `slot`;

/** A paid-size sandbox whose plan is no longer paid for: it spends the free hours until it is renewed or put on Free. */
export const planLapsed = (machine: Pick<HostedPlanMachine, `paid` | `tier`>, ladder: readonly Rung[]): boolean =>
    machine.paid === false && !rungOf(ladder, machine.tier).free;

/** The share of the billing period still to run at `now`: it ends at `renewsAt` and began a calendar month before. */
export const periodLeft = (renewsAt: string, now: number): number => {
    const end = new Date(renewsAt);
    const start = Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, end.getUTCDate(), end.getUTCHours(), end.getUTCMinutes(), end.getUTCSeconds());
    const length = end.getTime() - start;
    return length <= 0 ? 0 : Math.min(1, Math.max(0, (end.getTime() - now) / length));
};

/** About what moving up from `fromUsd` to `toUsd` adds to the next bill: the difference for the rest of the period, to the cent. */
export const prorationUsd = (toUsd: number, fromUsd: number, share: number): number => Math.max(0, Math.round((toUsd - fromUsd) * share * 100) / 100);

/** What a press in the change dialog does. */
export type PlanAct =
    // The plan it is on, with nothing waiting: nothing to press.
    | `current`
    // A downgrade waiting, withdrawn: the plan it is on, sent again.
    | `keep`
    // A paid upgrade whose resize did not finish, tried again with no new charge.
    | `retry`
    // Moved now (up, a renewal, a comped account's any move) or at the renewal date (down).
    | `change`
    // A first purchase: Stripe's page, for this sandbox.
    | `checkout`
    // Not possible: Free while another sandbox holds it.
    | `blocked`;

export interface PlanOffer {
    readonly act: PlanAct;
    /** The plan the press sends. */
    readonly tier: string;
    /** The button's words, saying the act ("Upgrade test-chmura · $20/month", "Switch to Free on 26 Dec"). */
    readonly label: string;
    /** The one sentence about money; none for a comped account, which pays nothing. */
    readonly price: string | undefined;
    /** Why the plan cannot be picked, said on its row. */
    readonly why: string | undefined;
    /** The sandbox restarts once to get bigger. */
    readonly restarts: boolean;
    /** The press spends money now: the page's one paid step. */
    readonly paid: boolean;
}

/** What a change of plan is decided from: the account, its plans, the sandbox, and the moment. */
export interface PlanContext {
    readonly state: HostedPlanState | undefined;
    readonly ladder: readonly Rung[];
    readonly machine: HostedPlanMachine;
    readonly now: number;
}

/** The account's other sandbox on Free, or the one scheduled to become free: the one a second Free is refused for. */
const freeHolder = (state: HostedPlanState | undefined, ladder: readonly Rung[], except: string | undefined): HostedPlanMachine | undefined =>
    (state?.hosted?.machines ?? []).find(
        (machine) => machine.sandboxId !== except && (rungOf(ladder, machine.tier).free || (machine.change !== undefined && rungOf(ladder, machine.change.tier).free)),
    );

/** Why Free cannot be picked for a sandbox, or undefined while it can (`freeLeft` absent on an older platform: never refused here). */
export const freeRefusal = (state: HostedPlanState | undefined, ladder: readonly Rung[], except: string | undefined): string | undefined => {
    if (state?.hosted?.freeLeft !== 0) {
        return undefined;
    }
    const holder = freeHolder(state, ladder, except);
    return holder === undefined ? t(`settings.plans.freeUsed`) : t(`settings.plans.freeUsedBy`, { name: holder.name });
};

// The sandbox gets more memory or disk than it has: the one kind of change that restarts it.
const grows = (machine: HostedPlanMachine, target: Rung): boolean => {
    const now = sizeOf(machine);
    return target.machine.memoryMb > now.memoryMb || target.machine.volumeGb > now.volumeGb || target.machine.cpus > now.cpus;
};

// A move to a smaller plan (or Free): at the renewal date for a plan paid for, at once for a comped account or a plan
// nobody pays for, since there is nothing to wait out.
const downOffer = (context: PlanContext, target: Rung, current: Rung): PlanOffer => {
    const base = { act: `change` as const, tier: target.id, why: undefined, restarts: false, paid: false };
    const renewsAt = context.state?.renewsAt;
    if (context.state?.comped === true || !planPaid(context.machine) || renewsAt === undefined) {
        return { ...base, label: t(`settings.plans.act.switchNow`, { name: target.name }), price: undefined };
    }
    const date = formatDayShort(renewsAt);
    return {
        ...base,
        label: t(`settings.plans.act.switchOn`, { name: target.name, date }),
        price: t(`settings.plans.price.down`, { date, name: target.name, current: current.name }),
    };
};

// A move to a bigger plan, or a lapsed one renewed: a checkout where nothing is paid yet, else charged now, prorated.
const upOffer = (context: PlanContext, target: Rung, renewing: boolean, fromUsd: number): PlanOffer => {
    const { state, machine, now } = context;
    const base = { tier: target.id, why: undefined, restarts: grows(machine, target) };
    const price = target.priceUsd;
    if (state?.comped === true) {
        return { ...base, act: `change`, label: t(`settings.plans.act.upgradeFree`, { sandbox: machine.name }), price: undefined, paid: false };
    }
    // A subscription whose charge Stripe is still retrying: its card is the way on, never a second subscription.
    if (state?.onPlan !== true && state?.status !== undefined && RECOVERABLE.has(state.status)) {
        return { ...base, act: `blocked`, label: t(`settings.plans.act.current`), price: undefined, paid: false, why: t(`settings.plans.bill.paymentFailed`) };
    }
    if (state?.onPlan !== true) {
        return { ...base, act: `checkout`, label: t(`settings.plans.act.checkout`), price: t(`settings.plans.price.first`, { price }), paid: true };
    }
    const label = renewing ? t(`settings.plans.act.renew`, { name: target.name, price }) : t(`settings.plans.act.upgrade`, { sandbox: machine.name, price });
    if ((state.hosted?.openSeats?.[target.id] ?? 0) > 0) {
        return { ...base, act: `change`, label, price: t(`settings.plans.price.seat`, { name: target.name }), paid: false };
    }
    const renewsAt = state.renewsAt;
    const words =
        renewsAt === undefined
            ? t(`settings.plans.price.monthly`, { price })
            : t(`settings.plans.price.prorated`, {
                  amount: formatMoney(prorationUsd(price, fromUsd, periodLeft(renewsAt, now))),
                  date: formatDayShort(renewsAt),
                  price,
              });
    return { ...base, act: `change`, label, price: words, paid: true };
};

/** What picking `target` for this sandbox would do, said as the dialog's button and its one sentence about money. */
export const planOffer = (context: PlanContext, target: Rung): PlanOffer => {
    const { state, ladder, machine, now } = context;
    const current = rungOf(ladder, machine.tier);
    const move = planMove(machine, now);
    const lapsed = planLapsed(machine, ladder);
    const still = { tier: target.id, why: undefined, restarts: false, paid: false };
    if (move.kind === `failed` && target.id === move.tier) {
        return { ...still, act: `retry`, label: t(`settings.plans.act.retry`), price: state?.comped === true ? undefined : t(`settings.plans.price.retry`), restarts: true };
    }
    if (target.id === current.id && !lapsed) {
        return move.kind === `scheduled`
            ? { ...still, act: `keep`, label: t(`settings.plans.act.keep`, { name: current.name }), price: t(`settings.plans.price.keep`, { name: current.name }) }
            : { ...still, act: `current`, label: t(`settings.plans.act.current`), price: undefined };
    }
    const refused = target.free ? freeRefusal(state, ladder, machine.sandboxId) : undefined;
    if (refused !== undefined) {
        return { ...still, act: `blocked`, label: t(`settings.plans.act.current`), price: undefined, why: refused };
    }
    const fromUsd = lapsed || !planPaid(machine) ? 0 : current.priceUsd;
    const renewing = lapsed && target.id === current.id;
    return target.priceUsd > fromUsd || renewing ? upOffer(context, target, renewing, fromUsd) : downOffer(context, target, current);
};

/** One line of what changes: a fact, before and after, and whether after is more. */
export interface PlanDiffRow {
    readonly label: string;
    readonly from: string;
    readonly to: string;
    readonly more: boolean;
}

const gb = (mb: number): string => t(`settings.plans.gb`, { gb: formatCount(mb / 1024) });

/** What moving this sandbox to `target` changes, fact by fact; its disk never shrinks, so a smaller plan keeps it. */
export const planDiff = (machine: HostedPlanMachine, current: Rung, target: Rung): PlanDiffRow[] => {
    const size = sizeOf(machine);
    const disk = Math.max(size.volumeGb, target.machine.volumeGb);
    const rows: PlanDiffRow[] = [
        { label: t(`settings.plans.diff.memory`), from: gb(size.memoryMb), to: gb(target.machine.memoryMb), more: target.machine.memoryMb > size.memoryMb },
        {
            label: t(`settings.plans.diff.disk`),
            from: t(`settings.plans.gb`, { gb: size.volumeGb }),
            to: disk > target.machine.volumeGb ? t(`settings.plans.diskKept`, { gb: disk }) : t(`settings.plans.gb`, { gb: disk }),
            more: disk > size.volumeGb,
        },
        {
            label: t(`settings.plans.diff.hours`),
            from: t(`settings.plans.hoursMonth`, { hours: current.hours }),
            to: target.free ? t(`settings.plans.hoursMonth`, { hours: target.hours }) : t(`settings.plans.hoursOwn`, { hours: target.hours }),
            more: target.hours > current.hours,
        },
    ];
    // Whether it is kept changes only between Free and a paid plan; between two paid plans the row would say nothing.
    if (current.free !== target.free) {
        rows.push({
            label: t(`settings.plans.diff.kept`),
            from: current.free ? t(`settings.plans.keptFree`) : t(`settings.plans.keptPaid`, { name: current.name }),
            to: target.free ? t(`settings.plans.keptFree`) : t(`settings.plans.keptPaid`, { name: target.name }),
            more: current.free,
        });
    }
    if (target.machine.cpus !== size.cpus) {
        rows.unshift({
            label: t(`settings.plans.diff.cpu`),
            from: String(size.cpus),
            to: String(target.machine.cpus),
            more: target.machine.cpus > size.cpus,
        });
    }
    return rows;
};

/** What a sandbox's Plan card leads with: the bright upgrade only where the free plan is pinching, else a quiet way in. */
export type CardLead =
    | { readonly kind: `upgrade`; readonly to: Rung }
    | { readonly kind: `change` }
    | { readonly kind: `renew` }
    | { readonly kind: `retry`; readonly tier: string }
    | { readonly kind: `none` };

/** A fifth of the month's hours or less is when the free plan starts to pinch. */
const PINCH_SHARE = 0.2;

export const cardLead = ({ ladder, machine, now }: Omit<PlanContext, `state`>): CardLead => {
    const move = planMove(machine, now);
    if (move.kind === `moving`) {
        return { kind: `none` };
    }
    if (move.kind === `failed`) {
        return { kind: `retry`, tier: move.tier };
    }
    if (planLapsed(machine, ladder)) {
        return { kind: `renew` };
    }
    const next = nextRung(ladder, machine.tier);
    const meter = hoursMeter(machine.hours);
    const pinched = (meter !== undefined && meter.fraction <= PINCH_SHARE) || machine.oomsThisWeek > 0;
    return rungOf(ladder, machine.tier).free && next !== undefined && pinched ? { kind: `upgrade`, to: next } : { kind: `change` };
};

/** The plan the dialog opens on for a press: the next one up for an upgrade, the plan waiting to be kept or retried. */
export const openingTier = (context: Omit<PlanContext, `state`>): string => {
    const lead = cardLead(context);
    const move = planMove(context.machine, context.now);
    if (lead.kind === `upgrade`) {
        return lead.to.id;
    }
    if (lead.kind === `retry`) {
        return lead.tier;
    }
    if (move.kind === `scheduled` || lead.kind === `renew`) {
        return context.machine.tier;
    }
    return nextRung(context.ladder, context.machine.tier)?.id ?? context.machine.tier;
};

/** The one quiet press on a Billing row, said as what it does there. */
export const rowActLabel = (context: Omit<PlanContext, `state`>): string => {
    const lead = cardLead(context);
    const move = planMove(context.machine, context.now);
    if (move.kind === `scheduled`) {
        return t(`settings.plans.act.keep`, { name: rungOf(context.ladder, context.machine.tier).name });
    }
    switch (lead.kind) {
        case `retry`:
            return t(`settings.plans.act.retry`);
        case `renew`:
            return t(`settings.plans.act.renewShort`);
        default:
            return rungOf(context.ladder, context.machine.tier).free ? t(`settings.plans.act.upgradeShort`) : t(`settings.plans.act.changeShort`);
    }
};

/** The plan a sandbox is billed at now: the bigger one an upgrade under way (or tried) has already paid for, else its own. */
const billedTier = (machine: HostedPlanMachine, now: number): string => {
    const move = planMove(machine, now);
    return (move.kind === `moving` || move.kind === `failed`) && isUpgrade(machine.tier, move.tier) ? move.tier : machine.tier;
};

/** What a sandbox costs a month now: its plan's price while that is paid for, nothing on Free or once its plan ended. */
export const monthlyUsdOf = (machine: HostedPlanMachine, ladder: readonly Rung[], now: number): number =>
    planPaid(machine) && !planLapsed(machine, ladder) ? rungOf(ladder, billedTier(machine, now)).priceUsd : 0;

/** The bill: what the paid sandboxes (and plans on no sandbox) cost a month now, and from the renewal date. */
export interface Bill {
    readonly monthlyUsd: number;
    readonly nextUsd: number;
}

export const billOf = (state: HostedPlanState | undefined, ladder: readonly Rung[], now: number): Bill => {
    const priceOf = (id: string): number => rungOf(ladder, id).priceUsd;
    const seats = Object.entries(state?.hosted?.openSeats ?? {}).reduce((sum, [tier, count]) => sum + count * priceOf(tier), 0);
    let monthlyUsd = seats;
    let nextUsd = seats;
    for (const machine of state?.hosted?.machines ?? []) {
        const current = monthlyUsdOf(machine, ladder, now);
        if (current === 0) {
            continue;
        }
        const move = planMove(machine, now);
        monthlyUsd += current;
        nextUsd += move.kind === `scheduled` ? priceOf(move.tier) : current;
    }
    return { monthlyUsd, nextUsd: state?.cancelAtPeriodEnd === true ? 0 : nextUsd };
};

/** One step of a machine's restart onto its new plan. */
export interface MoveStepView {
    readonly key: `paid` | MoveStep;
    readonly label: string;
    readonly state: `done` | `active` | `todo`;
}

const STEPS: readonly MoveStep[] = [`snapshot`, `resizing`, `starting`];

/** The restart's steps: the plan already changed (paid, for an upgrade with money in it), then snapshot, resize, start. */
export const moveSteps = (move: Extract<PlanMove, { kind: `moving` }>, from: string, comped: boolean): MoveStepView[] => {
    const at = STEPS.indexOf(move.step);
    const words = {
        snapshot: at > 0 ? t(`settings.plans.step.snapshotTaken`) : t(`settings.plans.step.snapshot`),
        resizing: t(`settings.plans.step.resizing`),
        starting: t(`settings.plans.step.starting`),
    } satisfies Record<MoveStep, string>;
    const first = isUpgrade(from, move.tier) && !comped ? t(`settings.plans.step.paid`) : t(`settings.plans.step.changed`);
    return [
        { key: `paid`, label: first, state: `done` },
        ...STEPS.map((key, index) => ({ key, label: words[key], state: index < at ? (`done` as const) : index === at ? (`active` as const) : (`todo` as const) })),
    ];
};

/** What making a new cloud sandbox on a plan does: the press's words, the one sentence about money, and how it pays. */
export interface NewSandboxPlan {
    /** `create` on Free (nothing to pay); `reserve` a plan for it first (a subscriber or comped); `checkout` a first purchase. */
    readonly act: `create` | `reserve` | `checkout`;
    /** The press's words where they differ from a plain Create ("Create · $20/month", "Continue to payment · $20/month"). */
    readonly label: string | undefined;
    readonly price: string | undefined;
    /** The press spends money now: the dialog's one paid step. */
    readonly paid: boolean;
}

export const newSandboxPlan = (state: HostedPlanState | undefined, target: Rung, now: number): NewSandboxPlan => {
    const price = target.priceUsd;
    if (target.free) {
        return { act: `create`, label: undefined, price: undefined, paid: false };
    }
    if (state?.onPlan !== true) {
        return { act: `checkout`, label: t(`settings.plans.newSandbox.checkout`, { price }), price: t(`settings.plans.price.first`, { price }), paid: true };
    }
    if (state.comped === true) {
        return { act: `reserve`, label: undefined, price: undefined, paid: false };
    }
    if ((state.hosted?.openSeats?.[target.id] ?? 0) > 0) {
        return { act: `reserve`, label: undefined, price: t(`settings.plans.price.seat`, { name: target.name }), paid: false };
    }
    const renewsAt = state.renewsAt;
    const words =
        renewsAt === undefined
            ? t(`settings.plans.price.monthly`, { price })
            : t(`settings.plans.price.prorated`, { amount: formatMoney(prorationUsd(price, 0, periodLeft(renewsAt, now))), date: formatDayShort(renewsAt), price });
    return { act: `reserve`, label: t(`settings.plans.newSandbox.create`, { price }), price: words, paid: true };
};
