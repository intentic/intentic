import type { HostedPlanState, HostedPlanUsage } from "@intentic/api-contract";

/* THE HOSTED PLAN'S SENTENCES, derived once from the plan state so the Billing page, the avatar menu's row,
 * the Overview card's line and the chat strip cannot disagree about a number or a word. Pure, so each sentence
 * is a test rather than a screenshot. */

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

/* The free lane's meter, or undefined for an owner it does not apply to (on the plan, a platform with no
 * ceiling). `fraction` is what is LEFT, 0..1, for a bar; the two minute figures are for the words. */
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

/* WHEN THE HOURS ARE WORTH INTERRUPTING FOR. Under five hours, or under an eighth of the allowance for a platform
 * whose ceiling is small: a strip that stood over every session from the first minute would read as the limit
 * about to hit rather than the forty hours it had (the trial strip's lesson). Spent is its own state. */
export const LOW_HOURS_MINUTES = 5 * 60;

export const lowOnHours = (meter: HoursMeter | undefined): boolean =>
    meter !== undefined && meter.remainingMinutes > 0 && meter.remainingMinutes <= Math.min(LOW_HOURS_MINUTES, meter.allowanceMinutes / 8);

export const hoursSpent = (meter: HoursMeter | undefined): boolean => meter !== undefined && meter.remainingMinutes === 0;

// "12 h of 40 h left this month", the meter's one line, shared by every surface that states it.
export const hoursLeftLine = (meter: HoursMeter): string =>
    meter.remainingMinutes === 0
        ? `Free hours used up this month`
        : `${formatMinutes(meter.remainingMinutes)} of ${formatMinutes(meter.allowanceMinutes)} left this month`;

/* THE AVATAR MENU'S ROW: one line about money or hours, or nothing. Nothing when the platform sells no plan
 * (the row would point at a page that does not exist), and nothing on a platform that runs no machines. */
export interface PlanRow {
    readonly text: string;
    readonly tone: `muted` | `warning`;
}

// A subscriber's row: the comp, the cancellation, or the date the plan renews (or a trial ends).
const subscriberRow = (state: HostedPlanState): PlanRow => {
    if (state.comped) {
        return { text: `Hosted · complimentary`, tone: `muted` };
    }
    if (state.renewsAt === undefined) {
        return { text: `Hosted plan`, tone: `muted` };
    }
    if (state.cancelAtPeriodEnd) {
        return { text: `Hosted plan · ends ${formatDayShort(state.renewsAt)}`, tone: `warning` };
    }
    return { text: `Hosted plan · ${state.status === `trialing` ? `trial ends` : `renews`} ${formatDayShort(state.renewsAt)}`, tone: `muted` };
};

// Everybody else's: a failing card first, then the free lane's hours, then nothing (no ceiling to speak of).
const freeLaneRow = (state: HostedPlanState): PlanRow | undefined => {
    if (state.status !== undefined && RECOVERABLE.has(state.status)) {
        return { text: `Hosted plan · payment failed`, tone: `warning` };
    }
    const meter = hoursMeter(state.hosted?.usage);
    if (meter === undefined) {
        return undefined;
    }
    return { text: hoursLeftLine(meter), tone: hoursSpent(meter) || lowOnHours(meter) ? `warning` : `muted` };
};

export const planRow = (state: HostedPlanState | undefined): PlanRow | undefined => {
    if (state === undefined || !state.enabled) {
        return undefined;
    }
    return state.onPlan ? subscriberRow(state) : freeLaneRow(state);
};

/* LAPSED IS NOT THE SAME AS NEVER. The platform's rule (hosted-plan.ts) counts `active` and `trialing` and
 * nothing else, so a subscriber whose card was declined arrives with `onPlan: false`, the same answer as
 * somebody who has never paid. `past_due`, `unpaid` and `incomplete` are Stripe retrying a live subscription:
 * they want the card fixed, not the product sold. */
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
