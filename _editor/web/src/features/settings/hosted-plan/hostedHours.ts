import type { HostedPlanState, HostedPlanUsage } from "@intentic/api-contract";
// Type only, so the barrel (and a DOM with it) is erased rather than booted: this module is unit-tested alone.
import type { StatusVariant } from "@intentic/ui";

/* THE HOSTED PLAN'S SENTENCES, derived once from the plan state so the Billing page, the avatar menu's badge,
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

// "12 h of 40 h left this month", the meter's one line, shared by every surface that states it.
export const hoursLeftLine = (meter: HoursMeter): string =>
    meter.remainingMinutes === 0
        ? `Free hours used up this month`
        : `${formatMinutes(meter.remainingMinutes)} of ${formatMinutes(meter.allowanceMinutes)} left this month`;

/* THE ACCOUNT MENU'S PLAN CHIP: which lane this account is on, in one word, beside the name it belongs to.
 * Absent only where the platform sells no plan, because then there is no lane to be on.
 *
 * IT REPLACED A STATUS SENTENCE, and the reason is worth keeping. The menu used to carry a row that read
 * "12 h of 40 h left this month" (amber when few were left) linking to Billing, on the argument that it was
 * the only place a free owner would meet their hours without going looking. That argument expired: the last
 * hours are now said above the composer, to the person spending them (ChatPaneNotices), and a wake refused
 * for want of hours is said at the gate, at the moment it bites (connectionNotice). What was left in the menu
 * was a third copy of an alarm, in the one place that cannot raise one — a menu is behind a click, so the
 * only reader it ever reaches is the reader who already went looking, who is the same person who would have
 * opened Billing anyway.
 *
 * What it cost was worse than the duplication. A subscriber's row said "Hosted plan · renews Oct 1" and a
 * comped account's said "Hosted · complimentary": a link, drawn like news, with nothing to act on, sitting
 * where a menu's rows are all verbs. So the plan stopped being a row and became what it always was — an
 * attribute of the person, stated next to them, asking nothing. The hours, the renewal date, the machines and
 * the slots belong to Billing, one row below.
 *
 * A FAILING CARD IS THE ONE ALARM THE CHIP STILL CARRIES. It is not news about usage; it is what this account
 * IS right now (on a plan nobody is paying for), it ends with the machine dropped to the free lane, and
 * Settings ▸ Billing is directly beneath it. It takes the danger tone and stays a chip. */
export interface PlanBadge {
    readonly label: string;
    readonly variant: StatusVariant;
    /* The sentence behind the word, on hover. The chip is the glance; this is the one thing a glance cannot
     * hold (which date, what a comp means); Billing is the whole story. */
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
    /* "ENDS", NOT "RENEWS": Stripe keeps the status active until the period runs out, so a subscriber who has
     * just cancelled would otherwise be told they renew. The chip says `ending` and takes the warning tone. */
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
    // A lapsed subscriber arrives here, not above (RECOVERABLE below): `onPlan` is false while Stripe retries.
    if (state.status !== undefined && RECOVERABLE.has(state.status)) {
        return { label: `payment failed`, variant: `danger`, detail: `Your card was declined. The hosted plan ends unless it is fixed.` };
    }
    /* THE FREE LANE IS A LANE, so it wears a chip like any other. The row this replaced fell silent on a
     * platform with no hour ceiling, because with no hours there was no sentence; a chip has no such problem,
     * and "not on the plan" is exactly the fact it exists to state. */
    return { label: `free`, variant: `neutral`, detail: `Free lane. This account is not on the hosted plan.` };
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
