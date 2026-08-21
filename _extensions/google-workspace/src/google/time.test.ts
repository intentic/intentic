import { describe, expect, it } from "vitest";
import { dateIn, defaultEnd, offsetOf, parseWhen, toInstant } from "./time.js";

/* A fixed instant, mid-summer so the Berlin cases exercise a DST offset, and late enough in the UTC evening
 * that Berlin is ALREADY ON THE NEXT DAY, which is the whole condition the zone handling exists for. */
const NOW = new Date("2026-08-09T22:30:00Z");
const BERLIN = "Europe/Berlin";

describe("parseWhen", () => {
    it("resolves `now` to an instant", () => {
        expect(parseWhen("now", NOW, BERLIN)).toEqual({ dateTime: "2026-08-09T22:30:00.000Z" });
    });

    it("resolves relative offsets in both directions and every unit", () => {
        expect(parseWhen("+2h", NOW, BERLIN).dateTime).toBe("2026-08-10T00:30:00.000Z");
        expect(parseWhen("-30m", NOW, BERLIN).dateTime).toBe("2026-08-09T22:00:00.000Z");
        expect(parseWhen("+3d", NOW, BERLIN).dateTime).toBe("2026-08-12T22:30:00.000Z");
        expect(parseWhen("+1w", NOW, BERLIN).dateTime).toBe("2026-08-16T22:30:00.000Z");
    });

    /* THE ONE THAT MATTERS. 22:30 UTC is already tomorrow in Berlin, so "today" answered from the process
     * clock would book the meeting a day early: every evening, for every owner east of UTC. */
    it("reads `today` in the calendar's zone, not the container's", () => {
        expect(parseWhen("today", NOW, BERLIN)).toEqual({ date: "2026-08-10" });
        expect(parseWhen("today", NOW, "UTC")).toEqual({ date: "2026-08-09" });
    });

    it("pairs a naive wall-clock time with the zone it is meant in, rather than converting it", () => {
        expect(parseWhen("tomorrow 09:00", NOW, BERLIN)).toEqual({ dateTime: "2026-08-11T09:00:00", timeZone: BERLIN });
        expect(parseWhen("2026-08-12 14:00", NOW, BERLIN)).toEqual({ dateTime: "2026-08-12T14:00:00", timeZone: BERLIN });
    });

    it("passes a full timestamp through untouched: it already says which moment it is", () => {
        expect(parseWhen("2026-08-12T14:00:00+02:00", NOW, BERLIN)).toEqual({ dateTime: "2026-08-12T14:00:00+02:00" });
        expect(parseWhen("2026-08-12T12:00:00Z", NOW, BERLIN)).toEqual({ dateTime: "2026-08-12T12:00:00Z" });
    });

    it("treats a bare date as the whole day", () => {
        expect(parseWhen("2026-08-12", NOW, BERLIN)).toEqual({ date: "2026-08-12" });
    });

    it("says what it does accept when it cannot read something", () => {
        expect(() => parseWhen("next tuesday-ish", NOW, BERLIN)).toThrow(/accepted: `now`/);
    });
});

describe("defaultEnd", () => {
    // Google's end.date is exclusive, so an all-day event that starts and ends on the same date is rejected.
    it("ends an all-day event on the following date", () => {
        expect(defaultEnd({ date: "2026-08-12" })).toEqual({ date: "2026-08-13" });
    });

    it("advances a naive time by an hour on the same wall clock, keeping the zone", () => {
        expect(defaultEnd({ dateTime: "2026-08-12T14:00:00", timeZone: BERLIN })).toEqual({ dateTime: "2026-08-12T15:00:00", timeZone: BERLIN });
    });

    it("advances an absolute instant by an hour", () => {
        expect(defaultEnd({ dateTime: "2026-08-12T12:00:00Z" })).toEqual({ dateTime: "2026-08-12T13:00:00.000Z" });
    });
});

describe("toInstant", () => {
    it("stamps a naive time with the zone's offset at that moment", () => {
        expect(toInstant("2026-08-12 14:00", NOW, BERLIN)).toBe("2026-08-12T14:00:00+02:00");
        expect(toInstant("2026-01-12 14:00", NOW, BERLIN)).toBe("2026-01-12T14:00:00+01:00");
    });

    it("starts a bare date at its own midnight in the zone", () => {
        expect(toInstant("2026-08-12", NOW, BERLIN)).toBe("2026-08-12T00:00:00+02:00");
    });

    it("leaves something already absolute alone", () => {
        expect(toInstant("+2h", NOW, BERLIN)).toBe("2026-08-10T00:30:00.000Z");
    });
});

describe("zone arithmetic", () => {
    it("reads a zone's offset from Intl, DST included", () => {
        expect(offsetOf(BERLIN, new Date("2026-08-09T12:00:00Z"))).toBe("+02:00");
        expect(offsetOf(BERLIN, new Date("2026-01-09T12:00:00Z"))).toBe("+01:00");
        expect(offsetOf("UTC", NOW)).toBe("+00:00");
    });

    it("answers what date it is somewhere", () => {
        expect(dateIn("Pacific/Auckland", NOW)).toBe("2026-08-10");
        expect(dateIn("America/Los_Angeles", NOW)).toBe("2026-08-09");
    });
});
