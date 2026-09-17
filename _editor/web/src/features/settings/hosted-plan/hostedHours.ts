import type { HostedPlanState, HostedPlanUsage } from "@intentic/api-contract";
import type { StatusVariant } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

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
    // Set while a new account's ceiling is the ramp's, not the month's: when the full one applies (ISO).
    readonly rampUntil?: string;
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
        ...(usage.rampUntil === undefined ? {} : { rampUntil: usage.rampUntil }),
    };
};

// Threshold for a low-hours warning: under 5h, or under an eighth of the allowance if the ceiling is smaller.
export const LOW_HOURS_MINUTES = 5 * 60;

export const lowOnHours = (meter: HoursMeter | undefined): boolean =>
    meter !== undefined && meter.remainingMinutes > 0 && meter.remainingMinutes <= Math.min(LOW_HOURS_MINUTES, meter.allowanceMinutes / 8);

// "12 h of 40 h left this month", the meter's one line, shared by every surface that states it. A new account's
// ramp names the day the full month applies instead of "this month", since its ceiling changes before the month does.
export const hoursLeftLine = (meter: HoursMeter): string => {
    const when = meter.rampUntil === undefined ? `this month` : `until ${formatDayShort(meter.rampUntil)}`;
    return meter.remainingMinutes === 0
        ? `Free hours used up ${when}`
        : `${formatMinutes(meter.remainingMinutes)} of ${formatMinutes(meter.allowanceMinutes)} left ${when}`;
};

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
        return { label: t(`settings.hostedHours.complimentary`), variant: `info`, detail: t(`settings.hostedHours.hostedPlanOnHouse`) };
    }
    if (state.renewsAt === undefined) {
        return { label: t(`settings.hostedHours.hosted`), variant: `primary`, detail: t(`settings.hostedHours.onHostedPlan`) };
    }
    // Stripe keeps status active until period end; without this a cancelled subscriber would read as renewing.
    if (state.cancelAtPeriodEnd) {
        return {
            label: t(`settings.hostedHours.ending`),
            variant: `warning`,
            detail: t(`settings.hostedHours.hostedPlanEndsAfter`, { renewsAt: formatDayShort(state.renewsAt) }),
        };
    }
    if (state.status === `trialing`) {
        return {
            label: t(`settings.hostedHours.trial`),
            variant: `info`,
            detail: t(`settings.hostedHours.hostedPlanTrialEnds`, { renewsAt: formatDayShort(state.renewsAt) }),
        };
    }
    return {
        label: t(`settings.hostedHours.hosted`),
        variant: `primary`,
        detail: t(`settings.hostedHours.hostedPlanRenews`, { renewsAt: formatDayShort(state.renewsAt) }),
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
        return { label: t(`settings.hostedHours.paymentFailed`), variant: `danger`, detail: t(`settings.hostedHours.cardDeclinedHostedPlan`) };
    }
    // Free lane gets a chip too, since a chip has no trouble stating "not on the plan" even with no hour ceiling.
    return { label: t(`settings.hostedHours.free`), variant: `neutral`, detail: t(`settings.hostedHours.freeLaneAccountNot`) };
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
