import { describe, expect, it } from "vitest";
import { pickUpOf, pickUpStatus, pressCost } from "./pickUp";

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
    it(`carries the held turn whole, and books a move as a wait that starts now`, () => {
        const ending = { reason: `limit` as const, resetsAt: 1_800_003_600, held: { ran: true, contextTokens: 85_000, handoffTokens: 6_000, moving: `alice` }, scheduled: true };
        expect(pickUpOf(ending, NOW)).toEqual({
            reason: `limit`,
            readyAt: 1_800_003_600_000,
            held: ending.held,
            automatic: { at: NOW },
        });
    });

    it(`aims an armed appointment at the reset, and books nothing without an instant`, () => {
        expect(pickUpOf({ reason: `limit`, resetsAt: 1_800_003_600, held: { ran: false }, scheduled: true }, NOW).automatic).toEqual({ at: 1_800_003_600_000 });
        expect(pickUpOf({ reason: `limit`, held: { ran: false }, scheduled: true }, NOW).automatic).toBeUndefined();
    });
});

describe(`pickUpStatus`, () => {
    it(`names where a booked move is going, and whether anything ran`, () => {
        expect(pickUpStatus({ reason: `limit`, held: { ran: true, moving: `alice` }, automatic: { at: NOW } }, undefined, NOW)).toBe(
            `Limit reached · work kept · moving to alice now`,
        );
        expect(pickUpStatus({ reason: `limit`, held: { ran: false, moving: `alice` }, automatic: { at: NOW } }, undefined, NOW)).toBe(
            `Limit reached · nothing ran · moving to alice now`,
        );
    });

    it(`still counts an appointment down`, () => {
        expect(pickUpStatus({ reason: `limit`, held: { ran: true }, automatic: { at: NOW + 120_000 } }, undefined, NOW)).toMatch(/^Limit reached · sending again in /u);
    });
});
