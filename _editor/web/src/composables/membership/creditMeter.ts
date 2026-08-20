import type { MembershipState } from "@intentic-app/api-contract";

/* WHAT A DAY'S CREDIT ALLOWANCE COMES TO, as every surface that draws it needs it, the account menu's line,
 * the premium install's price, the composer's pill and the membership card's meter.
 *
 * The platform sends four raw numbers (allowance, used, remaining, resetsAt) and every reader wants the same
 * three things from them: a percentage for a bar, a word for whether there is anything left, and "how many
 * installs is that", which is the only unit a reader of this product already has a feel for. Those were
 * arithmetic inside the membership card, which was fine while it was the one place credits appeared and became
 * the reason nowhere else could show them without copying it.
 *
 * THE BAR MEASURES WHAT IS LEFT, not what is gone, and that is deliberate: every other meter in this app is a
 * utilization (a rate limit filling up towards a wall), while this one is a wallet emptying. Drawing them the
 * same way round would make a productive day look like an incident.
 *
 * WHICH IS ALSO WHY THERE IS NO DANGER TONE HERE. usageStatus.ts turns a plan limit red at 90% because a spent
 * rate limit stops the person working. A spent credit allowance is the opposite event: the money went to the
 * people who wrote what you used, which is what the membership is FOR. So an empty meter is stated plainly and
 * at most warning-coloured, never alarming, see the membership card's own note that a low meter is a day's
 * work done rather than a fault. */

export interface CreditMeter {
    readonly allowance: number;
    readonly used: number;
    readonly remaining: number;
    /** Next UTC midnight, as the platform sent it. Rendered local by `resetsAtLocal`. */
    readonly resetsAt: string;
    /** How much of today's allowance is LEFT, 0–100, what a bar draws. */
    readonly remainingPercent: number;
    /** Nothing left to spend today. */
    readonly spent: boolean;
    /** Some left, but not enough for one more premium install, the point where the catalogue stops being open. */
    readonly low: boolean;
    /** Anything at all has been spent today. What makes the meter worth showing unprompted. */
    readonly touched: boolean;
}

/** Readable integers, everywhere credits are said out loud. */
export const formatCredits = (value: number): string => value.toLocaleString();

/* How many premium installs a credit figure buys. Guarded against a zero donation price, which is a
 * configuration a self-hosted platform is allowed to have, and which would otherwise divide by it. */
export const installsFor = (credits: number, donationCredits: number): number => (donationCredits > 0 ? Math.floor(credits / donationCredits) : 0);

/* THE BUY BUTTON'S OWN NAME. The button is the last thing read before a decision, so it says which decision
 * this is, "Rejoin" for somebody who has been a member before. Here rather than on a page because there are
 * two buying surfaces now (the settings tab, and /join for somebody who arrived from a terminal with no
 * sandbox), and a price phrased two ways is the kind of difference readers notice and distrust. */
export const joinLabel = (state: MembershipState | undefined, returning: boolean): string =>
    `${returning ? `Rejoin` : `Join`} for $${formatCredits(state?.priceUsd ?? 0)}/month`;

/* Whether this account has been a member before. A lapsed or cancelled membership leaves a `status` behind
 * while `member` is false, the same shape a never-member has, minus that trace. */
export const hasReturned = (state: MembershipState | undefined): boolean => state?.member === false && state.status !== undefined;

/* The meter, or nothing. Absent for a non-member and on a platform that sells no membership: neither has an
 * allowance, and a zeroed bar would claim they had one and had spent it. */
export const creditMeter = (state: MembershipState | undefined): CreditMeter | undefined => {
    const credits = state?.credits;
    if (state === undefined || credits === undefined) {
        return undefined;
    }
    const remainingPercent = credits.allowance > 0 ? Math.round((credits.remaining / credits.allowance) * 100) : 0;
    return {
        ...credits,
        remainingPercent,
        spent: credits.remaining <= 0,
        /* Measured in installs rather than in percent, because that is a threshold with a MEANING: below it the
         * one flat-priced thing in the product is out of reach today, which is a fact worth saying. A percentage
         * would be a number somebody picked.
         *
         * A platform that gives its extensions away (donationCredits: 0) has no such threshold, there is no
         * price for the balance to fall short of, so nothing is ever low there. Without that guard a FULL
         * allowance read as low, since "installs you can afford" is zero when installs cost nothing. */
        low: state.donationCredits > 0 && credits.remaining > 0 && installsFor(credits.remaining, state.donationCredits) === 0,
        touched: credits.used > 0,
    };
};

/** What would be left after spending `price`, the figure an install's confirmation owes its reader. */
export const remainingAfter = (meter: CreditMeter | undefined, price: number): number => Math.max(0, (meter?.remaining ?? 0) - price);

/* Whether today's allowance covers a price. Unknown counts as affordable: a surface that could not read the
 * meter must not gray out the only button on it, and the platform refuses an unaffordable spend anyway. */
export const affordable = (meter: CreditMeter | undefined, price: number): boolean => meter === undefined || meter.remaining >= price;

/* The reset as a clock the reader owns. UTC midnight is the platform's boundary and nobody's local habit, so it
 * is always rendered in local time, "resets at 1:00 AM" is actionable where "00:00 UTC" is homework. */
export const resetsAtLocal = (meter: CreditMeter | undefined): string | undefined =>
    meter === undefined ? undefined : new Date(meter.resetsAt).toLocaleTimeString(undefined, { hour: `numeric`, minute: `2-digit` });

/* One line for the surfaces too small to draw a bar, the account menu's low-balance marker and the composer
 * pill's accessible name. */
export const creditSummary = (meter: CreditMeter | undefined): string =>
    meter === undefined
        ? ``
        : meter.spent
          ? `Today's credits are spent. The full allowance comes back at ${resetsAtLocal(meter)}.`
          : `${formatCredits(meter.remaining)} of ${formatCredits(meter.allowance)} credits left today, resetting at ${resetsAtLocal(meter)}.`;
