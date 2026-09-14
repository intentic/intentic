import { describe, expect, it } from "vitest";
import { cacheCooling, cacheWarm, type CacheStanding } from "./promptCache";

// No mocks: promptCache is a pure-function leaf over agentStatus, like the projections it sits beside.
const none = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
const NOW = 1_700_000_000_000;
const MINUTE = 60 * 1_000;
const HOUR = 60 * MINUTE;

// Parked on a question with an hour's cache written five minutes ago: the case the mark exists for, and far enough from
// the deadline that every silence below is the rule under test rather than this default.
const agent = (over: Partial<CacheStanding> = {}): CacheStanding => ({
    status: `awaiting`,
    attention: { ...none, question: true },
    promptCache: { at: NOW - 5 * MINUTE, ttlMs: HOUR },
    contextTokens: 184_000,
    ...over,
});

// The window is a fraction of the entry's own life, not a fixed lead: a minute is the whole of a five-minute cache and
// nothing of an hour's, so one number cannot serve both.
describe("cacheCooling", () => {
    it("says nothing while the cache has time to spare", () => {
        expect(cacheCooling(agent(), NOW)).toBeUndefined();
        // 20 minutes left of an hour: still four fifths of nothing to do about it.
        expect(cacheCooling(agent({ promptCache: { at: NOW - 40 * MINUTE, ttlMs: HOUR } }), NOW)).toBeUndefined();
    });

    it("opens the window at a fifth left, at either lifetime", () => {
        // An hour's cache: 11 minutes left is inside the fifth, 13 is not.
        expect(cacheCooling(agent({ promptCache: { at: NOW - 49 * MINUTE, ttlMs: HOUR } }), NOW)?.countdown).toBe(`11m 0s`);
        expect(cacheCooling(agent({ promptCache: { at: NOW - 47 * MINUTE, ttlMs: HOUR } }), NOW)).toBeUndefined();
        // Five minutes' cache: the same 11 minutes is long cold, and its own fifth is 45 seconds.
        expect(cacheCooling(agent({ promptCache: { at: NOW - 4 * MINUTE - 15_000, ttlMs: 5 * MINUTE } }), NOW)?.countdown).toBe(`45s`);
        expect(cacheCooling(agent({ promptCache: { at: NOW - 3 * MINUTE, ttlMs: 5 * MINUTE } }), NOW)).toBeUndefined();
    });

    // Quiet on arrival, louder as it closes: the chip is a nudge, and one that arrives loud is an alarm about money
    // nobody has spent.
    it("turns near only once its own window is half gone", () => {
        expect(cacheCooling(agent({ promptCache: { at: NOW - 50 * MINUTE, ttlMs: HOUR } }), NOW)?.near).toBe(false);
        expect(cacheCooling(agent({ promptCache: { at: NOW - 57 * MINUTE, ttlMs: HOUR } }), NOW)?.near).toBe(true);
    });

    // A cold cache is not a warning, it is a fact nobody can act on; marking it would leave every settled card wearing a
    // chip for ever.
    it("says nothing once the cache is cold", () => {
        expect(cacheCooling(agent({ promptCache: { at: NOW - HOUR, ttlMs: HOUR } }), NOW)).toBeUndefined();
    });

    // Absent is "nobody published a lifetime for this provider", which must not read as "expiring": a guessed deadline
    // is indistinguishable from a measured one on a card.
    it("says nothing when the daemon grounded no deadline", () => {
        expect(cacheCooling(agent({ promptCache: undefined }), NOW)).toBeUndefined();
    });

    // A running turn refreshes its own entry on every request, so its deadline is always moving away from the reader.
    it("says nothing while a turn is in flight", () => {
        expect(cacheCooling(agent({ status: `running`, attention: none, promptCache: { at: NOW - 55 * MINUTE, ttlMs: HOUR } }), NOW)).toBeUndefined();
    });

    // The user is done with a Finished card; what its follow-up would cost is not a reason to reopen it.
    it("says nothing for a conversation the user has finished with", () => {
        expect(cacheCooling(agent({ status: `landed`, attention: none, promptCache: { at: NOW - 55 * MINUTE, ttlMs: HOUR } }), NOW)).toBeUndefined();
    });

    // What the tooltip has to carry: the size is the whole argument for answering now, and its absence must not leave a
    // sentence with a hole in it.
    it("names the context it would re-send, and reads without it", () => {
        const cooling = cacheCooling(agent({ promptCache: { at: NOW - 55 * MINUTE, ttlMs: HOUR } }), NOW);
        expect(cooling?.hint).toContain(`184k tokens`);
        expect(cooling?.hint).toContain(`goes cold in 5m 0s`);
        const unmeasured = cacheCooling(agent({ contextTokens: undefined, promptCache: { at: NOW - 55 * MINUTE, ttlMs: HOUR } }), NOW);
        expect(unmeasured?.hint).toContain(`everything it has already read`);
    });
});

// The card's clock gate: armed for the whole life of the entry, since the roster frame that ends a turn is the only
// thing that re-reads it, and the chip has to appear on a minute no frame announces.
describe("cacheWarm", () => {
    it("holds from the write to the deadline, and no longer", () => {
        expect(cacheWarm(agent(), NOW)).toBe(true);
        expect(cacheWarm(agent({ promptCache: { at: NOW - HOUR, ttlMs: HOUR } }), NOW)).toBe(false);
        expect(cacheWarm(agent({ promptCache: undefined }), NOW)).toBe(false);
    });

    // Matches the chip exactly: arming a clock for a card that can never draw one is a ticker with nothing to show.
    it("stays down for the cards the chip skips", () => {
        expect(cacheWarm(agent({ status: `running`, attention: none }), NOW)).toBe(false);
        expect(cacheWarm(agent({ status: `landed`, attention: none }), NOW)).toBe(false);
    });
});
