import type { HostedPlanState } from "@intentic/api-contract";
import { describe, expect, it } from "vitest";
import { formatDayShort, formatMinutes, hoursLeftLine, hoursMeter, lowOnHours, machineStandingLine, planBadge } from "./hostedHours";

/* The sentences every hosted-plan surface shares. Pinned as words, because the failure this module exists to
 * prevent is two surfaces answering the same question differently. */

const usage = (usedMinutes: number, allowanceMinutes: number | null = 2_400) => ({
    month: `2026-09`,
    usedMinutes,
    allowanceMinutes,
    resetsAt: `2026-10-01T00:00:00.000Z`,
});

const hosted = (usedMinutes: number, allowanceMinutes: number | null = 2_400) => ({
    slots: 1,
    machines: [],
    usage: usage(usedMinutes, allowanceMinutes),
    shape: { cpus: 4, memoryMb: 4096, volumeGb: 10 },
});

const state = (over: Partial<HostedPlanState> = {}): HostedPlanState => ({ enabled: true, onPlan: false, priceUsd: 20, ...over });

// A live subscriber, whose chip differs only by the one field each case is about.
const RENEWS_AT = `2026-10-01T00:00:00.000Z`;
const subscriber = (over: Partial<HostedPlanState> = {}): HostedPlanState => state({ onPlan: true, status: `active`, renewsAt: RENEWS_AT, ...over });

/* The free lane's whole chip, spelled once because it is the answer to four different questions — spent hours,
 * unspent hours, no ceiling at all, no machine — and the point of those cases is that the answer never moves. */
const FREE = { label: `free`, variant: `neutral`, detail: `Free lane. This account is not on the hosted plan.` };

describe(`minutes as words`, () => {
    it(`speaks minutes under an hour, whole hours plain, and a decimal otherwise`, () => {
        expect(formatMinutes(45)).toBe(`45 min`);
        expect(formatMinutes(120)).toBe(`2 h`);
        expect(formatMinutes(150)).toBe(`2.5 h`);
        expect(formatMinutes(-3)).toBe(`0 min`);
    });
});

describe(`the meter`, () => {
    it(`is absent for an owner the ceiling does not apply to`, () => {
        expect(hoursMeter(undefined)).toBeUndefined();
        expect(hoursMeter(usage(500, null))).toBeUndefined();
    });

    it(`never reads negative, and says spent when it is`, () => {
        const meter = hoursMeter(usage(9_000));
        expect(meter).toMatchObject({ remainingMinutes: 0, fraction: 0 });
        expect(hoursLeftLine(meter!)).toBe(`Free hours used up this month`);
    });

    it(`states what is left of what`, () => {
        expect(hoursLeftLine(hoursMeter(usage(1_680))!)).toBe(`12 h of 40 h left this month`);
    });

    // The strip's threshold: five hours, or an eighth of a small allowance, and never while spent (its own state).
    it(`is low under five hours, but not at the first minute of a month, and not once spent`, () => {
        expect(lowOnHours(hoursMeter(usage(2_100)))).toBe(true);
        expect(lowOnHours(hoursMeter(usage(0)))).toBe(false);
        expect(lowOnHours(hoursMeter(usage(2_400)))).toBe(false);
        // A platform with an 8-hour ceiling: low at an hour, not at four.
        expect(lowOnHours(hoursMeter(usage(420, 480)))).toBe(true);
        expect(lowOnHours(hoursMeter(usage(240, 480)))).toBe(false);
    });
});

describe(`the account menu's plan chip`, () => {
    it(`says nothing where nothing is sold`, () => {
        expect(planBadge(undefined)).toBeUndefined();
        expect(planBadge(state({ enabled: false }))).toBeUndefined();
    });

    /* THE CHIP IS ABOUT THE LANE, NEVER THE METER. The row it replaced spelled out the hours here and went
     * amber as they ran down; that alarm belongs to the composer's strip and the wake gate, which are in the
     * reader's path, and a menu is not. Every free owner gets the same quiet word whatever they have spent. */
    it(`gives the free lane one quiet word, whatever the meter says`, () => {
        for (const spent of [0, 2_200, 2_400]) {
            expect(planBadge(state({ hosted: hosted(spent) }))).toEqual(FREE);
        }
    });

    // A lane is a lane with or without an hour ceiling, so unlike the row, the chip still shows up here.
    it(`still names the free lane on a platform with no ceiling`, () => {
        expect(planBadge(state({ hosted: hosted(500, null) }))).toEqual(FREE);
        expect(planBadge(state())).toEqual(FREE);
    });

    /* "ENDS", NOT "RENEWS", for a subscriber who has cancelled: Stripe keeps the status active until the period
     * runs out, and the one word is the difference between a chip that agrees with what they just did and one
     * that contradicts it. The sentence says what happens after, because "ends" alone reads as the account
     * ending rather than the plan. */
    it(`turns hosted into ending once the plan is cancelling`, () => {
        expect(planBadge(subscriber())).toEqual({
            label: `hosted`,
            variant: `primary`,
            detail: `Hosted plan, renews ${formatDayShort(RENEWS_AT)}.`,
        });
        expect(planBadge(subscriber({ cancelAtPeriodEnd: true }))).toEqual({
            label: `ending`,
            variant: `warning`,
            detail: `Hosted plan ends ${formatDayShort(RENEWS_AT)}. After that, the free lane.`,
        });
    });

    it(`names a trial, a comp, and a plan with no date`, () => {
        expect(planBadge(subscriber({ status: `trialing` }))).toEqual({
            label: `trial`,
            variant: `info`,
            detail: `Hosted plan trial, ends ${formatDayShort(RENEWS_AT)}.`,
        });
        // No card and no renewal, which is the whole of what a comp means to the person holding one.
        expect(planBadge(state({ onPlan: true, comped: true }))).toEqual({
            label: `complimentary`,
            variant: `info`,
            detail: `Hosted plan, on the house. No card, no renewal.`,
        });
        expect(planBadge(state({ onPlan: true }))).toEqual({ label: `hosted`, variant: `primary`, detail: `On the hosted plan.` });
    });

    /* THE ONE ALARM THE CHIP CARRIES. A lapsed subscriber arrives with `onPlan: false` — the same answer as
     * somebody who never paid — so this must be read before the free lane, or a declined card reads `free`. The
     * sentence has to say what is at stake, since the chip is two words and Billing is one row below it. */
    it(`takes the danger tone for a failing card, ahead of the free lane`, () => {
        for (const status of [`past_due`, `unpaid`, `incomplete`]) {
            expect(planBadge(state({ status, renewsAt: `2026-09-01T00:00:00.000Z`, hosted: hosted(0) }))).toEqual({
                label: `payment failed`,
                variant: `danger`,
                detail: `Your card was declined. The hosted plan ends unless it is fixed.`,
            });
        }
    });

    /* Every state carries its hover sentence, and the six of them are six different sentences: a chip nobody can
     * expand must still be explainable, and two lanes explained with the same words explain neither. */
    it(`gives every state its own sentence to hover`, () => {
        const every = [
            state({ hosted: hosted(0) }),
            state({ status: `past_due` }),
            state({ onPlan: true, comped: true }),
            subscriber({ status: `trialing` }),
            subscriber(),
            subscriber({ cancelAtPeriodEnd: true }),
        ];
        const details = every.map((one) => planBadge(one)?.detail);
        expect(details.filter((detail) => detail?.endsWith(`.`))).toHaveLength(every.length);
        expect(new Set(details).size).toBe(every.length);
    });
});

describe(`the machine's standing`, () => {
    it(`credits the plan, the comp, or states the hours`, () => {
        expect(machineStandingLine(state({ onPlan: true, hosted: hosted(0, null) }))).toBe(`Always on · covered by your Hosted plan`);
        expect(machineStandingLine(state({ onPlan: true, comped: true, hosted: hosted(0, null) }))).toBe(`Always on · complimentary`);
        expect(machineStandingLine(state({ hosted: hosted(1_680) }))).toBe(`12 h of 40 h left this month`);
        expect(machineStandingLine(state({ hosted: hosted(0, null) }))).toBe(`Always on`);
        expect(machineStandingLine(state())).toBeUndefined();
    });
});
