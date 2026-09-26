import { TranscriptFold } from "../text/transcript-fold.js";
import {
    changedParts,
    keepWarmCap,
    keepWarmDueAt,
    keepWarmHorizon,
    keepWarmLeadMs,
    keepWarmRefreshes,
    keptWarmLine,
} from "./keep-warm.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// The clock both the daemon and every press read, so the refreshes shown before a press are the ones the daemon sends.
describe("keep-warm economics", () => {
    test("refreshes a fifth of an entry's life early, never under a minute or over ten", () => {
        expect(keepWarmLeadMs(HOUR)).toBe(10 * MINUTE);
        expect(keepWarmLeadMs(5 * MINUTE)).toBe(MINUTE);
    });

    test("counts the refreshes that keep an entry alive through the deadline", () => {
        const cache = { at: 0, ttlMs: HOUR };
        expect(keepWarmRefreshes(cache, HOUR)).toBe(0);
        expect(keepWarmRefreshes(cache, 4 * HOUR)).toBe(4);
        expect(keepWarmDueAt(cache)).toBe(50 * MINUTE);
    });

    test("reaches no further than the refreshes left carry it, or the date change when that comes first", () => {
        const cache = { at: 0, ttlMs: HOUR };
        expect(keepWarmHorizon(cache, 9)).toBe(HOUR + 9 * 50 * MINUTE);
        expect(keepWarmHorizon(cache, -2)).toBe(HOUR);
        expect(keepWarmCap(cache, 3 * HOUR, 9)).toBe(3 * HOUR);
        expect(keepWarmCap({ at: 0, ttlMs: 5 * MINUTE }, undefined, 5)).toBe(5 * MINUTE + 5 * 4 * MINUTE);
    });

    test("names the parts two fingerprints disagree on", () => {
        const before = { hash: "a", parts: { version: "1", model: "m", day: "d1" } };
        expect(changedParts(before, { hash: "b", parts: { version: "2", model: "m", day: "d2" } })).toEqual(["day", "version"]);
        expect(changedParts(before, before)).toEqual([]);
    });
});

describe("the receipt a kept conversation's turn leaves", () => {
    test("says it picked up warm, and for how long it was kept", () => {
        expect(keptWarmLine({ readTokens: 251_000, writtenTokens: 3_000, kept: { forMs: 3 * HOUR + 12 * MINUTE, refreshes: 4 } })).toBe(
            "Picked up warm: 251k tokens read from the cache, kept warm for 3h 12m with 4 refreshes.",
        );
    });

    test("says so plainly when the turn went cold anyway", () => {
        expect(keptWarmLine({ readTokens: 0, writtenTokens: 250_000, kept: { forMs: 40 * MINUTE, refreshes: 1 } })).toContain("Picked up cold");
    });

    test("is a notice row in the transcript, and nothing for a turn nobody kept", () => {
        const fold = new TranscriptFold([]);
        expect(fold.apply({ kind: "prompt_cache", readTokens: 10, writtenTokens: 200_000 })).toEqual([]);
        fold.apply({ kind: "prompt_cache", readTokens: 251_000, writtenTokens: 3_000, kept: { forMs: HOUR, refreshes: 1 } });
        expect(fold.rows.at(-1)).toMatchObject({ role: "notice", text: expect.stringContaining("Picked up warm") });
    });
});
