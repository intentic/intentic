import { describe, expect, test } from "vitest";
import { asCivilDay, asZone, civilDayIn, cronOptions, isZone, sameClock, utcDayOf, UTC, zoneLabel } from "./zone.js";
import type { Zone } from "./zone.js";

// The distinctions this module exists to keep, each of which was a live bug before it: a cron evaluated in the
// process's zone instead of the author's, a civil day rendered as if it were an instant, and a zone label shown to a
// reader who is already on that clock.

const WARSAW = "Europe/Warsaw" as Zone;
const NEW_YORK = "America/New_York" as Zone;
// 2026-09-20T20:43Z. Warsaw is +2 (summer time), New York -4.
const SEPTEMBER = Date.UTC(2026, 8, 20, 20, 43);
// 2026-12-20T20:43Z. Warsaw is +1, New York -5: the same two zones, different offsets.
const DECEMBER = Date.UTC(2026, 11, 20, 20, 43);

describe(`isZone`, () => {
    test(`accepts what ICU knows and refuses what it does not`, () => {
        expect(isZone(`Europe/Warsaw`)).toBe(true);
        expect(isZone(`UTC`)).toBe(true);
        expect(isZone(`Europe/Warszawa`)).toBe(false);
        expect(isZone(``)).toBe(false);
    });

    /* An offset is not a zone: it cannot say what happens in March, which is the whole reason schedules need a zone. */
    test(`refuses a bare offset, which is the shape that looks like it would work`, () => {
        expect(isZone(`+02:00`)).toBe(false);
        expect(isZone(`UTC+2`)).toBe(false);
    });

    test(`asZone passes real ids through and swallows the rest`, () => {
        expect(asZone(`America/New_York`)).toBe(`America/New_York`);
        expect(asZone(`Mars/Olympus`)).toBeUndefined();
        expect(asZone(undefined)).toBeUndefined();
    });
});

describe(`civilDayIn`, () => {
    /* THE ONE THAT MATTERS: one instant, three zones, three different calendar days. */
    test(`an instant falls on different days depending on the zone asked`, () => {
        // 2026-09-20T23:30Z: already the 21st in Warsaw, still the 20th in UTC and New York.
        const lateEvening = Date.UTC(2026, 8, 20, 23, 30);
        expect(civilDayIn(lateEvening, WARSAW)).toBe(`2026-09-21`);
        expect(civilDayIn(lateEvening, UTC)).toBe(`2026-09-20`);
        expect(civilDayIn(lateEvening, NEW_YORK)).toBe(`2026-09-20`);
    });

    test(`utcDayOf is civilDayIn UTC, spelled so every UTC bucket is greppable`, () => {
        expect(utcDayOf(SEPTEMBER)).toBe(civilDayIn(SEPTEMBER, UTC));
    });

    test(`asCivilDay takes the shape and nothing else`, () => {
        expect(asCivilDay(`2026-09-20`)).toBe(`2026-09-20`);
        expect(asCivilDay(`2026-09-20T00:00:00Z`)).toBeUndefined();
        expect(asCivilDay(`20/09/2026`)).toBeUndefined();
    });
});

describe(`sameClock`, () => {
    test(`two zones on the same offset right now read as one clock`, () => {
        expect(sameClock(WARSAW, `Europe/Berlin` as Zone, SEPTEMBER)).toBe(true);
        expect(sameClock(WARSAW, UTC, SEPTEMBER)).toBe(false);
    });

    /* Asked at an instant, not in the abstract: London and Warsaw differ all year, London and UTC only in summer. */
    test(`the answer is a property of the instant, not of the pair`, () => {
        expect(sameClock(`Europe/London` as Zone, UTC, SEPTEMBER)).toBe(false);
        expect(sameClock(`Europe/London` as Zone, UTC, DECEMBER)).toBe(true);
    });
});

describe(`zoneLabel`, () => {
    test(`names the zone for a reader on a different clock`, () => {
        expect(zoneLabel(WARSAW, NEW_YORK, SEPTEMBER)).toBe(`Europe/Warsaw`);
    });

    test(`stays quiet for a reader already on that clock, rather than adding width for nothing`, () => {
        expect(zoneLabel(WARSAW, `Europe/Berlin` as Zone, SEPTEMBER)).toBeUndefined();
        expect(zoneLabel(UTC, UTC, SEPTEMBER)).toBeUndefined();
    });

    test(`underscores become spaces, since the id is read as words here`, () => {
        expect(zoneLabel(NEW_YORK, UTC, SEPTEMBER)).toBe(`America/New York`);
    });
});

describe(`cronOptions`, () => {
    test(`hands croner the key it actually reads`, () => {
        expect(cronOptions(WARSAW)).toEqual({ timezone: `Europe/Warsaw` });
    });
});
