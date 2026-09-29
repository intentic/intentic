import type { HostedHoursMeter, HostedPlanMachine, HostedPlanState } from "@intentic/api-contract";
import { HOSTED_TIERS } from "@intentic/constants";
import type { StatusVariant, Tip } from "@intentic/ui";
// Through `@intentic/ui/format`, not the barrel: this module is plain TypeScript, tested without a DOM, and the
// barrel drags in the component graph — a chart component reaching for `window.matchMedia` at import time takes the
// whole suite down before a single assertion runs. Same reason `markdown` and `series` have their own subpaths.
import { formatDateLong, formatDayMonth } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";

// Sentences derived from hosted-plan state so Billing, the account badge, a sandbox's own pages and the chat strip
// cannot disagree. Pure functions, tested rather than screenshotted.
//
// Two kinds of hours, and a hosted machine spends exactly one of them (api hosted-usage.ts): the ACCOUNT's free hours,
// shared by every machine that does not stand on a paid slot, or ONE MACHINE's own month on the slot it stands on. A
// sandbox on its owner's own computer spends neither, so nothing here is ever said about one.

// Minutes as a person reads them: under an hour in minutes, whole hours plain, otherwise one decimal.
export const formatMinutes = (minutes: number): string => {
    const clamped = Math.max(0, Math.round(minutes));
    if (clamped < 60) {
        return `${clamped} min`;
    }
    const hours = clamped / 60;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
};

/**
 * A calendar day, in the reader's own clock, for "renews on" / "ends on" / "resets on".
 *
 * TAKES AN INSTANT, not a calendar day, and the parameter name says so. Handed `"2026-10-01"` these would parse it as
 * UTC midnight and render the 30th of September for every reader behind UTC — correct in the author's zone, wrong for
 * a third of the world, and invisible to whoever writes it. The platform sends `.toISOString()` for all three of
 * these fields; a `CivilDay` would need `civilDayIn` and its own bucketing zone instead.
 */
export const formatDay = (instant: string): string => formatDateLong(instant);

// Shorter, for the one-line surfaces (the avatar row) where a year is noise. Same contract: an instant, not a day.
export const formatDayShort = (instant: string): string => formatDayMonth(new Date(instant).getTime());

/** One kind of hours as a bar and a sentence draw it; `fraction` is what is left, 0..1. */
export interface HoursMeter {
    readonly kind: HostedHoursMeter[`kind`];
    readonly usedMinutes: number;
    readonly allowanceMinutes: number;
    readonly remainingMinutes: number;
    readonly fraction: number;
    readonly resetsAt: string;
    // Set while a new account's free hours are the ramp's, not the month's: when the full figure applies (ISO).
    readonly rampUntil?: string;
}

/** The meter for hours held to a ceiling; undefined for hours counted against none (a comp, a platform without one). */
export const hoursMeter = (hours: HostedHoursMeter | undefined): HoursMeter | undefined => {
    if (hours === undefined || hours.allowanceMinutes === null) {
        return undefined;
    }
    const remainingMinutes = Math.max(0, hours.allowanceMinutes - hours.usedMinutes);
    return {
        kind: hours.kind,
        usedMinutes: hours.usedMinutes,
        allowanceMinutes: hours.allowanceMinutes,
        remainingMinutes,
        fraction: hours.allowanceMinutes === 0 ? 0 : remainingMinutes / hours.allowanceMinutes,
        resetsAt: hours.resetsAt,
        ...(hours.rampUntil === undefined ? {} : { rampUntil: hours.rampUntil }),
    };
};

// Threshold for a low-hours warning: under 5h, or under an eighth of the allowance if the ceiling is smaller.
export const LOW_HOURS_MINUTES = 5 * 60;

export const lowOnHours = (meter: HoursMeter | undefined): boolean =>
    meter !== undefined && meter.remainingMinutes > 0 && meter.remainingMinutes <= Math.min(LOW_HOURS_MINUTES, meter.allowanceMinutes / 8);

// "12 h of 40 h left this month", the meter's one line, shared by every surface that states it. A new account's
// ramp names the day the full month applies instead of "this month", since its ceiling changes before the month does.
export const hoursLeftLine = (meter: HoursMeter): string => {
    const until = meter.rampUntil === undefined ? undefined : formatDayShort(meter.rampUntil);
    if (meter.remainingMinutes === 0) {
        if (meter.kind === `slot`) {
            return t(`settings.hostedHours.slotUsedUpThisMonth`);
        }
        return until === undefined ? t(`settings.hostedHours.freeUsedUpThisMonth`) : t(`settings.hostedHours.freeUsedUpUntil`, { day: until });
    }
    const figures = { left: formatMinutes(meter.remainingMinutes), allowance: formatMinutes(meter.allowanceMinutes) };
    return until === undefined ? t(`settings.hostedHours.leftThisMonth`, figures) : t(`settings.hostedHours.leftUntil`, { ...figures, day: until });
};

/** A rung as a reader meets it; an id the ladder does not know is shown as itself rather than hidden. */
export const rungName = (tier: string): string => HOSTED_TIERS.find((rung) => rung.id === tier)?.name ?? tier;

/** One machine's hours as its surfaces draw them: whose they are, one line about them, and a meter where one applies. */
export interface MachineHours {
    readonly label: string;
    readonly line: string;
    readonly meter: HoursMeter | undefined;
}

/**
 * WHOSE HOURS A MACHINE SPENDS, AND WHAT IS LEFT OF THEM. A machine on a paid slot has its own month, labelled with
 * its rung; any other spends the account's free hours, labelled as shared when a second machine spends them too. Hours
 * held to no ceiling say how much was spent instead, credited to the comp where that is why.
 */
export const machineHours = (state: HostedPlanState | undefined, machine: HostedPlanMachine): MachineHours => {
    const meter = hoursMeter(machine.hours);
    if (meter === undefined) {
        return {
            label: state?.comped === true ? t(`settings.hostedHours.onTheHouse`) : t(`settings.hostedHours.noHourLimit`),
            line: t(`settings.hostedHours.awakeThisMonth`, { used: formatMinutes(machine.hours.usedMinutes) }),
            meter,
        };
    }
    if (machine.hours.kind === `slot`) {
        return { label: t(`settings.hostedHours.slotHours`, { name: rungName(machine.tier) }), line: hoursLeftLine(meter), meter };
    }
    const sharing = (state?.hosted?.machines ?? []).filter((other) => other.hours.kind === `free`).length > 1;
    return { label: sharing ? t(`settings.hostedHours.freeHoursShared`) : t(`settings.hostedHours.freeHours`), line: hoursLeftLine(meter), meter };
};

/** The hours of the sandbox the reader is looking at, as one line; undefined where the reader holds no such machine. */
export const sandboxHoursLine = (state: HostedPlanState | undefined, sandboxId: string | undefined): string | undefined => {
    const machine = state?.hosted?.machines.find((row) => row.sandboxId === sandboxId);
    if (machine === undefined) {
        return undefined;
    }
    const { label, line } = machineHours(state, machine);
    return t(`settings.hostedHours.labelledLine`, { label, line });
};

/** The chat strip's sentence once a machine's hours run low; undefined while they don't. */
export const lowHoursNotice = (state: HostedPlanState | undefined, sandboxId: string | undefined): string | undefined => {
    const machine = state?.hosted?.machines.find((row) => row.sandboxId === sandboxId);
    const meter = hoursMeter(machine?.hours);
    if (machine === undefined || !lowOnHours(meter) || meter === undefined) {
        return undefined;
    }
    const { label, line } = machineHours(state, machine);
    return t(`settings.hostedHours.lowHoursNotice`, { line: t(`settings.hostedHours.labelledLine`, { label, line }), day: formatDayShort(meter.resetsAt) });
};

// Which lane this account is on, one word beside the name; absent when the platform sells no plan. A failing card is
// the one alarm the chip still carries, in the danger tone.
export interface PlanBadge {
    readonly label: string;
    readonly variant: StatusVariant;
    // Hover card behind the label: the plan and its one date; Billing gives the full story.
    readonly detail: Tip;
}

const HOSTED = (): string => t(`settings.settingsBilling.hostedPlan`);

// A subscriber's chip: the comp, the cancellation, the trial, or the plain plan and the date it renews.
const subscriberBadge = (state: HostedPlanState): PlanBadge => {
    if (state.comped) {
        return {
            label: t(`settings.hostedHours.complimentary`),
            variant: `info`,
            detail: { title: HOSTED(), note: t(`settings.hostedHours.tipNoCard`) },
        };
    }
    if (state.renewsAt === undefined) {
        return { label: t(`settings.hostedHours.hosted`), variant: `primary`, detail: { title: HOSTED() } };
    }
    const day = formatDayShort(state.renewsAt);
    // Stripe keeps status active until period end; without this a cancelled subscriber would read as renewing.
    if (state.cancelAtPeriodEnd) {
        return {
            label: t(`settings.hostedHours.ending`),
            variant: `warning`,
            detail: {
                title: HOSTED(),
                tone: `warn`,
                rows: [{ label: t(`settings.hostedHours.tipEnds`), value: day }],
                note: t(`settings.hostedHours.tipThenFree`),
            },
        };
    }
    if (state.status === `trialing`) {
        return {
            label: t(`settings.hostedHours.trial`),
            variant: `info`,
            detail: { title: t(`settings.hostedHours.tipTrial`), rows: [{ label: t(`settings.hostedHours.tipEnds`), value: day }] },
        };
    }
    return {
        label: t(`settings.hostedHours.hosted`),
        variant: `primary`,
        detail: { title: HOSTED(), rows: [{ label: t(`settings.hostedHours.tipRenews`), value: day }] },
    };
};

export const planBadge = (state: HostedPlanState | undefined): PlanBadge | undefined => {
    if (state === undefined || !state.enabled) {
        return undefined;
    }
    if (state.onPlan) {
        return subscriberBadge(state);
    }
    // A lapsed subscriber lands here, not in subscriberBadge, since `onPlan` is false while Stripe retries payment.
    if (state.status !== undefined && RECOVERABLE.has(state.status)) {
        return {
            label: t(`settings.hostedHours.paymentFailed`),
            variant: `danger`,
            detail: { title: t(`settings.hostedHours.tipCardDeclined`), tone: `danger`, note: t(`settings.hostedHours.tipEndsUnlessFixed`) },
        };
    }
    // Free plan gets a chip too, since a chip has no trouble stating "not on the plan" even with no hour ceiling.
    return { label: t(`settings.hostedHours.free`), variant: `neutral`, detail: { title: t(`settings.settingsBilling.freePlan`) } };
};

// Statuses where Stripe is retrying a live subscription, not a sale: `past_due`, `unpaid`, `incomplete`.
export const RECOVERABLE = new Set([`past_due`, `unpaid`, `incomplete`]);
