import type { HostedPlanState, HostedPlanUsage } from "@intentic/api-contract";
import type { StatusVariant } from "@intentic/ui";

// Sentences derived from hosted-plan state so Billing, the account badge, Overview and the chat strip cannot disagree.
// Pure functions, tested rather than screenshotted.

// Minutes as a person reads them: under an hour in minutes, whole hours plain, otherwise one decimal.
export const formatMinutes = (minutes: number): string => {
    const clamped = Math.max(0, Math.round(minutes));
    if (clamped < 60) {
        return `${clamped} min`;
    }
    const hours = clamped / 60;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
};

// A calendar day, in the reader's locale, for "renews on" / "ends on" / "resets on".
export const formatDay = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { year: `numeric`, month: `long`, day: `numeric` });

// Shorter, for the one-line surfaces (the avatar row) where a year is noise.
export const formatDayShort = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { month: `short`, day: `numeric` });

// Free lane usage meter; undefined for an owner it doesn't apply to (on the plan, or no ceiling). `fraction` is what's
// left, 0..1, for a bar; the minute fields are for the sentence.
export interface HoursMeter {
    readonly usedMinutes: number;
    readonly allowanceMinutes: number;
    readonly remainingMinutes: number;
    readonly fraction: number;
    readonly resetsAt: string;
}

export const hoursMeter = (usage: HostedPlanUsage | undefined): HoursMeter | undefined => {
    if (usage === undefined || usage.allowanceMinutes === null) {
        return undefined;
    }
    const remainingMinutes = Math.max(0, usage.allowanceMinutes - usage.usedMinutes);
    return {
        usedMinutes: usage.usedMinutes,
        allowanceMinutes: usage.allowanceMinutes,
        remainingMinutes,
        fraction: usage.allowanceMinutes === 0 ? 0 : remainingMinutes / usage.allowanceMinutes,
        resetsAt: usage.resetsAt,
    };
};

// Threshold for a low-hours warning: under 5h, or under an eighth of the allowance if the ceiling is smaller.
export const LOW_HOURS_MINUTES = 5 * 60;

export const lowOnHours = (meter: HoursMeter | undefined): boolean =>
    meter !== undefined && meter.remainingMinutes > 0 && meter.remainingMinutes <= Math.min(LOW_HOURS_MINUTES, meter.allowanceMinutes / 8);

// "12 h of 40 h left this month", the meter's one line, shared by every surface that states it.
export const hoursLeftLine = (meter: HoursMeter): string =>
    meter.remainingMinutes === 0
        ? `Free hours used up this month`
        : `${formatMinutes(meter.remainingMinutes)} of ${formatMinutes(meter.allowanceMinutes)} left this month`;

// Which lane this account is on, one word beside the name; absent when the platform sells no plan. A failing card is
// the one alarm the chip still carries, in the danger tone.
export interface PlanBadge {
    readonly label: string;
    readonly variant: StatusVariant;
    // Hover sentence behind the label; Billing gives the full story.
    readonly detail: string;
}

// A subscriber's chip: the comp, the cancellation, the trial, or the plain plan and the date it renews.
const subscriberBadge = (state: HostedPlanState): PlanBadge => {
    if (state.comped) {
        return { label: `complimentary`, variant: `info`, detail: `Hosted plan, on the house. No card, no renewal.` };
    }
    if (state.renewsAt === undefined) {
        return { label: `hosted`, variant: `primary`, detail: `On the hosted plan.` };
    }
    // Stripe keeps status active until period end; without this a cancelled subscriber would read as renewing.
    if (state.cancelAtPeriodEnd) {
        return { label: `ending`, variant: `warning`, detail: `Hosted plan ends ${formatDayShort(state.renewsAt)}. After that, the free lane.` };
    }
    if (state.status === `trialing`) {
        return { label: `trial`, variant: `info`, detail: `Hosted plan trial, ends ${formatDayShort(state.renewsAt)}.` };
    }
    return { label: `hosted`, variant: `primary`, detail: `Hosted plan, renews ${formatDayShort(state.renewsAt)}.` };
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
        return { label: `payment failed`, variant: `danger`, detail: `Your card was declined. The hosted plan ends unless it is fixed.` };
    }
    // Free lane gets a chip too, since a chip has no trouble stating "not on the plan" even with no hour ceiling.
    return { label: `free`, variant: `neutral`, detail: `Free lane. This account is not on the hosted plan.` };
};

// Statuses where Stripe is retrying a live subscription, not a sale: `past_due`, `unpaid`, `incomplete`.
export const RECOVERABLE = new Set([`past_due`, `unpaid`, `incomplete`]);

// The Overview card's one line about the machine's standing under the owner's plan.
export const machineStandingLine = (state: HostedPlanState | undefined): string | undefined => {
    if (state === undefined || state.hosted === undefined) {
        return undefined;
    }
    if (state.onPlan) {
        return state.comped ? `Always on · complimentary` : `Always on · covered by your Hosted plan`;
    }
    const meter = hoursMeter(state.hosted.usage);
    return meter === undefined ? `Always on` : hoursLeftLine(meter);
};
