import type { MembershipState } from "@intentic-app/api-contract";
import { describe, expect, it } from "vitest";
import { affordable, creditMeter, creditSummary, installsFor, remainingAfter } from "./creditMeter";

/* The platform's published shape, with the figures this product actually ships: a 1,000-credit day and a
 * 200-credit install, so a full allowance is five installs and the thresholds have somewhere to land. */
const state = (credits: { used: number; remaining: number } | undefined, donationCredits = 200): MembershipState =>
    ({
        enabled: true,
        member: credits !== undefined,
        priceUsd: 20,
        creatorShare: 0.7,
        dailyCredits: 1_000,
        donationCredits,
        credits: credits === undefined ? undefined : { allowance: 1_000, resetsAt: `2026-08-13T00:00:00.000Z`, ...credits },
    }) as MembershipState;

describe(`creditMeter`, () => {
    it(`has nothing to draw for a non-member`, () => {
        expect(creditMeter(state(undefined))).toBeUndefined();
    });

    it(`has nothing to draw before the membership state arrives`, () => {
        expect(creditMeter(undefined)).toBeUndefined();
    });

    it(`measures what is LEFT, so an untouched day reads full`, () => {
        const meter = creditMeter(state({ used: 0, remaining: 1_000 }));
        expect(meter?.remainingPercent).toBe(100);
        expect(meter?.spent).toBe(false);
        expect(meter?.touched).toBe(false);
    });

    it(`notices the first spend, which is what makes the meter worth showing unprompted`, () => {
        expect(creditMeter(state({ used: 200, remaining: 800 }))?.touched).toBe(true);
        expect(creditMeter(state({ used: 200, remaining: 800 }))?.remainingPercent).toBe(80);
    });

    it(`calls it low exactly when one more install is out of reach, not at a percentage somebody picked`, () => {
        expect(creditMeter(state({ used: 801, remaining: 199 }))?.low).toBe(true);
        expect(creditMeter(state({ used: 800, remaining: 200 }))?.low).toBe(false);
    });

    it(`is spent rather than low once there is nothing left`, () => {
        const meter = creditMeter(state({ used: 1_000, remaining: 0 }));
        expect(meter?.spent).toBe(true);
        expect(meter?.low).toBe(false);
        expect(meter?.remainingPercent).toBe(0);
    });

    // A platform that gives its extensions away has no install price to divide by, and must not divide by it.
    it(`survives a platform where an install donates nothing`, () => {
        const meter = creditMeter(state({ used: 0, remaining: 1_000 }, 0));
        expect(meter?.low).toBe(false);
        expect(installsFor(1_000, 0)).toBe(0);
    });

    it(`never draws a bar for an allowance of zero`, () => {
        const zeroed = {
            ...state({ used: 0, remaining: 0 }),
            credits: { allowance: 0, used: 0, remaining: 0, resetsAt: `2026-08-13T00:00:00.000Z` },
        };
        expect(creditMeter(zeroed as MembershipState)?.remainingPercent).toBe(0);
    });
});

describe(`installsFor`, () => {
    it(`floors, because a part-funded install is not an install`, () => {
        expect(installsFor(1_000, 200)).toBe(5);
        expect(installsFor(199, 200)).toBe(0);
        expect(installsFor(450, 200)).toBe(2);
    });
});

describe(`spending a known price`, () => {
    const meter = creditMeter(state({ used: 200, remaining: 800 }));

    it(`says what would be left afterwards`, () => {
        expect(remainingAfter(meter, 200)).toBe(600);
    });

    it(`floors at zero rather than reporting a debt the platform would never allow`, () => {
        expect(remainingAfter(meter, 5_000)).toBe(0);
    });

    it(`knows what today covers`, () => {
        expect(affordable(meter, 800)).toBe(true);
        expect(affordable(meter, 801)).toBe(false);
    });

    // A surface that could not read the meter must not gray out its own only button.
    it(`treats an unknown meter as affordable, because the platform refuses the spend anyway`, () => {
        expect(affordable(undefined, 200)).toBe(true);
        expect(remainingAfter(undefined, 200)).toBe(0);
    });
});

describe(`creditSummary`, () => {
    it(`states the balance and its reset for anything a screen reader has to hear`, () => {
        expect(creditSummary(creditMeter(state({ used: 200, remaining: 800 })))).toMatch(/^800 of 1,000 credits left today, resetting at /);
    });

    it(`says the allowance comes back, rather than reporting a zero and stopping`, () => {
        expect(creditSummary(creditMeter(state({ used: 1_000, remaining: 0 })))).toMatch(/^Today's credits are spent\./);
    });

    it(`says nothing at all where there is no meter`, () => {
        expect(creditSummary(undefined)).toBe(``);
    });
});
