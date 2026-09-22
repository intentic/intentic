import { describe, it, expect } from "bun:test";
import { pickUpNext, pickUpOf, pickUpStatus, pickUpWhen, pressCost } from "./pickUp";

const NOW = 1_800_000_000_000;

describe(`pressCost`, () => {
    it(`reads the plain press off the daemon's own arms: a turn that ran re-reads its session, one refused at the door pays the hand-off`, () => {
        expect(pressCost({ ran: true, contextTokens: 85_000, handoffTokens: 6_000 })).toEqual({ kind: `reread`, tokens: 85_000 });
        expect(pressCost({ ran: false, contextTokens: 85_000, handoffTokens: 6_000 })).toEqual({ kind: `handoff`, tokens: 6_000 });
    });

    it(`says nothing about a hold the daemon did not measure`, () => {
        expect(pressCost({ ran: true })).toBeUndefined();
        expect(pressCost({ ran: false })).toBeUndefined();
        expect(pressCost(undefined)).toBeUndefined();
    });
});

describe(`pickUpOf`, () => {
    it(`carries the held turn whole, and keeps the reset apart from the booking`, () => {
        const held = { ran: true, contextTokens: 85_000, handoffTokens: 6_000, moving: `alice` };
        expect(pickUpOf({ reason: `limit`, resetsAt: 1_800_003_600, nextAt: 1_800_003_600, held, scheduled: true })).toEqual({
            reason: `limit`,
            readyAt: 1_800_003_600_000,
            nextAt: 1_800_003_600_000,
            held,
        });
    });

    // A ladder rung falls short of any reset, and a stopped turn has no allowance at all: one field could not carry both.
    it(`takes a booking with no allowance behind it`, () => {
        expect(pickUpOf({ reason: `stopped`, nextAt: 1_800_000_015, held: { ran: true }, scheduled: true })).toEqual({
            reason: `stopped`,
            nextAt: 1_800_000_015_000,
            held: { ran: true },
        });
    });
});

// The defect that made a reader believe there were two different waits: one card said "back at Sun 08:20" over
// "continuing in about 244 min", which are the same instant in two formats nobody can line up.
describe(`pickUpWhen`, () => {
    it(`states a far instant as a clock AND a wait, in units a reader does not have to divide`, () => {
        const line = pickUpWhen(NOW + 244 * 60_000, NOW);
        expect(line).toContain(`about 4h`);
        expect(line).not.toContain(`min`);
    });

    it(`counts a near instant down without a clock time nobody needs`, () => {
        expect(pickUpWhen(NOW + 4 * 60_000, NOW)).toBe(`about 4 min`);
    });
});

describe(`pickUpStatus`, () => {
    // Two shapes of the same wall: hit mid-flight, or spent before the first request. Claiming survival for both is
    // what makes the line untrustworthy.
    it(`says whether anything ran, and when the allowance is back`, () => {
        expect(pickUpStatus({ reason: `limit`, held: { ran: true }, readyAt: NOW + 3_600_000 }, undefined, NOW)).toBe(
            `Limit reached · work kept · back about 60 min`,
        );
        expect(pickUpStatus({ reason: `limit`, held: { ran: false } }, undefined, NOW)).toBe(`Limit reached · nothing ran`);
    });

    it(`spends the breaker's tries out loud, and says nothing about what happens next`, () => {
        expect(pickUpStatus({ reason: `outage` }, { attempt: 2, maxAttempts: 5 }, NOW)).toBe(`Provider failed · work kept · try 2 of 5`);
        expect(pickUpStatus({ reason: `stopped`, held: { ran: true } }, undefined, NOW)).toBe(`Turn stopped short · work kept`);
    });
});

describe(`pickUpNext`, () => {
    // The whole point of one question with one answer: `wait` shows no countdown at all, so a card can never carry a
    // clock for an automation nobody armed.
    it(`says nothing while the answer is to wait`, () => {
        expect(pickUpNext({ reason: `limit`, readyAt: NOW + 3_600_000 }, `wait`, undefined, NOW)).toBeUndefined();
    });

    it(`names the instant the chosen answer fires`, () => {
        expect(pickUpNext({ reason: `limit`, readyAt: NOW + 3_600_000 }, `resend`, undefined, NOW)).toBe(`Goes by itself about 60 min`);
    });

    // The booking, not the allowance: a rung fires long before any reset the frame also carries.
    it(`prefers the daemon's own booking to the allowance behind it`, () => {
        expect(pickUpNext({ reason: `stopped`, readyAt: NOW + 3_600_000, nextAt: NOW + 15_000 }, `retry`, undefined, NOW)).toBe(
            `Goes by itself about 15s`,
        );
    });

    it(`counts an outage's tries, and reports a booked move instead of an hour`, () => {
        expect(pickUpNext({ reason: `outage`, nextAt: NOW + 30_000 }, `retry`, { attempt: 2, maxAttempts: 5 }, NOW)).toBe(
            `Next try about 30s · try 2 of 5`,
        );
        expect(pickUpNext({ reason: `limit`, held: { ran: true, moving: `alice` } }, `wait`, undefined, NOW)).toBe(`Moving to alice now`);
    });
});
