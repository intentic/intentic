import type { HostedPlanState } from "@intentic/api-contract";
import { describe, expect, it } from "vitest";
import { formatMinutes, hoursLeftLine, hoursMeter, lowOnHours, machineStandingLine, planRow } from "./hostedHours";

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

describe(`the avatar row`, () => {
    it(`says nothing where nothing is sold`, () => {
        expect(planRow(undefined)).toBeUndefined();
        expect(planRow(state({ enabled: false }))).toBeUndefined();
    });

    it(`gives the free lane its hours, and turns them amber when few are left`, () => {
        expect(planRow(state({ hosted: hosted(1_680) }))).toEqual({ text: `12 h of 40 h left this month`, tone: `muted` });
        expect(planRow(state({ hosted: hosted(2_200) }))).toMatchObject({ tone: `warning` });
        expect(planRow(state({ hosted: hosted(2_400) }))).toEqual({ text: `Free hours used up this month`, tone: `warning` });
    });

    it(`says nothing about hours on a platform with no ceiling`, () => {
        expect(planRow(state({ hosted: hosted(500, null) }))).toBeUndefined();
    });

    /* "ENDS", NOT "RENEWS", for a subscriber who has cancelled: Stripe keeps the status active until the period
     * runs out, and the one word is the difference between a page that agrees with what they just did and one
     * that contradicts it. */
    it(`turns renews into ends once the plan is cancelling`, () => {
        const renewing = planRow(state({ onPlan: true, status: `active`, renewsAt: `2026-10-01T00:00:00.000Z` }));
        expect(renewing?.text).toMatch(/^Hosted plan · renews /);
        const ending = planRow(state({ onPlan: true, status: `active`, renewsAt: `2026-10-01T00:00:00.000Z`, cancelAtPeriodEnd: true }));
        expect(ending?.text).toMatch(/^Hosted plan · ends /);
        expect(ending?.tone).toBe(`warning`);
    });

    it(`names a trial's end, a comp, and a failing card`, () => {
        expect(planRow(state({ onPlan: true, status: `trialing`, renewsAt: `2026-10-01T00:00:00.000Z` }))?.text).toMatch(/^Hosted plan · trial ends /);
        expect(planRow(state({ onPlan: true, comped: true }))).toEqual({ text: `Hosted · complimentary`, tone: `muted` });
        expect(planRow(state({ status: `past_due`, renewsAt: `2026-09-01T00:00:00.000Z`, hosted: hosted(0) }))).toEqual({
            text: `Hosted plan · payment failed`,
            tone: `warning`,
        });
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
