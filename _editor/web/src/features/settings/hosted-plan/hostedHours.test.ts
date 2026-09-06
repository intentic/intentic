import type { HostedPlanState } from "@intentic/api-contract";
import { describe, expect, it } from "vitest";
import { formatMinutes, hoursLeftLine, hoursMeter, lowOnHours, machineStandingLine, planBadge } from "./hostedHours";

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
        expect(planBadge(state({ hosted: hosted(0) }))).toMatchObject({ label: `free`, variant: `neutral` });
        expect(planBadge(state({ hosted: hosted(2_200) }))).toMatchObject({ label: `free`, variant: `neutral` });
        expect(planBadge(state({ hosted: hosted(2_400) }))).toMatchObject({ label: `free`, variant: `neutral` });
    });

    // A lane is a lane with or without an hour ceiling, so unlike the row, the chip still shows up here.
    it(`still names the free lane on a platform with no ceiling`, () => {
        expect(planBadge(state({ hosted: hosted(500, null) }))).toMatchObject({ label: `free` });
        expect(planBadge(state())).toMatchObject({ label: `free` });
    });

    /* "ENDS", NOT "RENEWS", for a subscriber who has cancelled: Stripe keeps the status active until the period
     * runs out, and the one word is the difference between a chip that agrees with what they just did and one
     * that contradicts it. */
    it(`turns hosted into ending once the plan is cancelling`, () => {
        expect(planBadge(state({ onPlan: true, status: `active`, renewsAt: `2026-10-01T00:00:00.000Z` }))).toMatchObject({
            label: `hosted`,
            variant: `primary`,
        });
        const ending = planBadge(state({ onPlan: true, status: `active`, renewsAt: `2026-10-01T00:00:00.000Z`, cancelAtPeriodEnd: true }));
        expect(ending).toMatchObject({ label: `ending`, variant: `warning` });
        expect(ending?.detail).toMatch(/^Hosted plan ends /);
    });

    it(`names a trial, a comp, and a plan with no date`, () => {
        expect(planBadge(state({ onPlan: true, status: `trialing`, renewsAt: `2026-10-01T00:00:00.000Z` }))).toMatchObject({
            label: `trial`,
            variant: `info`,
        });
        expect(planBadge(state({ onPlan: true, comped: true }))).toMatchObject({ label: `complimentary`, variant: `info` });
        expect(planBadge(state({ onPlan: true }))).toMatchObject({ label: `hosted`, detail: `On the hosted plan.` });
    });

    /* THE ONE ALARM THE CHIP CARRIES. A lapsed subscriber arrives with `onPlan: false` — the same answer as
     * somebody who never paid — so this must be read before the free lane, or a declined card reads `free`. */
    it(`takes the danger tone for a failing card, ahead of the free lane`, () => {
        for (const status of [`past_due`, `unpaid`, `incomplete`]) {
            expect(planBadge(state({ status, renewsAt: `2026-09-01T00:00:00.000Z`, hosted: hosted(0) }))).toMatchObject({
                label: `payment failed`,
                variant: `danger`,
            });
        }
    });

    // Every state carries its hover sentence: a chip nobody can expand must still be explainable.
    it(`always has a detail to hover`, () => {
        const every = [
            state({ hosted: hosted(0) }),
            state({ status: `past_due` }),
            state({ onPlan: true, comped: true }),
            state({ onPlan: true, status: `trialing`, renewsAt: `2026-10-01T00:00:00.000Z` }),
            state({ onPlan: true, status: `active`, renewsAt: `2026-10-01T00:00:00.000Z` }),
            state({ onPlan: true, status: `active`, renewsAt: `2026-10-01T00:00:00.000Z`, cancelAtPeriodEnd: true }),
        ];
        for (const one of every) {
            expect(planBadge(one)?.detail).toMatch(/\.$/);
        }
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
