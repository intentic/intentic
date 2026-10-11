import {
    calendarWeeks,
    CLOCK_CHIPS,
    clockText,
    dayOf,
    defaultClock,
    draftInstant,
    minuteOfDay,
    moveDay,
    parseClock,
    stepClock,
} from "./laterCalendar";

// The send-later picker as values: the weeks the thirty-day booking window spans, the day keyboard movement lands on,
// a time of day read the way people type one, and the instant a half-made pick names. Every instant is built on the
// reader's own clock, so the suite reads the same in any zone.

const at = (month: number, day: number, hour = 0, minute = 0): number => new Date(2026, month - 1, day, hour, minute).getTime();
const MONDAY = 1;
const SUNDAY = 0;

describe(`the weeks a booking can land in`, () => {
    // 2026-10-11 is a Sunday: the last day of a Monday week, so the window's thirty days reach into a sixth week.
    it(`lays the whole window out in whole weeks from the reader's first weekday, the first of a month marked`, () => {
        const weeks = calendarWeeks(at(10, 11, 1, 25), MONDAY);
        expect(weeks).toHaveLength(6);
        expect(weeks.every((week) => week.length === 7)).toBe(true);
        expect(weeks[0]?.[0]?.day).toBe(at(10, 5));
        expect(weeks.at(-1)?.at(-1)?.day).toBe(at(11, 15));
        const days = weeks.flat();
        expect(days.filter((day) => day.today).map((day) => day.day)).toEqual([at(10, 11)]);
        expect(days.filter((day) => day.monthStart).map((day) => day.day)).toEqual([at(11, 1)]);
        const bookable = days.filter((day) => day.bookable);
        expect(bookable[0]?.day).toBe(at(10, 11));
        expect(bookable.at(-1)?.day).toBe(at(11, 10));
        expect(bookable).toHaveLength(31);
    });

    it(`starts a week where the reader's calendar does`, () => {
        const weeks = calendarWeeks(at(10, 11, 1, 25), SUNDAY);
        expect(weeks).toHaveLength(5);
        expect(weeks[0]?.[0]?.day).toBe(at(10, 11));
        expect(weeks[0]?.[0]?.today).toBe(true);
    });

    // A minute before midnight, the soonest bookable minute is already tomorrow's.
    it(`leaves today out once no minute of it can be booked`, () => {
        const days = calendarWeeks(at(10, 11, 23, 59) + 30_000, MONDAY).flat();
        expect(days.find((day) => day.today)?.bookable).toBe(false);
        expect(days.find((day) => day.bookable)?.day).toBe(at(10, 12));
    });

    it(`moves the keyboard's day by days and weeks, never off the window`, () => {
        const now = at(10, 11, 9);
        expect(moveDay(at(10, 12), 7, now)).toBe(at(10, 19));
        expect(moveDay(at(10, 12), -7, now)).toBe(at(10, 11));
        expect(moveDay(at(11, 8), 7, now)).toBe(at(11, 10));
    });
});

describe(`a time of day, typed`, () => {
    it(`reads the ways people write one`, () => {
        const cases: Record<string, number> = {
            "9": 9 * 60,
            "09": 9 * 60,
            "930": 9 * 60 + 30,
            "0930": 9 * 60 + 30,
            "9:30": 9 * 60 + 30,
            "9.30": 9 * 60 + 30,
            "9h30": 9 * 60 + 30,
            " 21:05 ": 21 * 60 + 5,
            "1530": 15 * 60 + 30,
            "9pm": 21 * 60,
            "9:30 am": 9 * 60 + 30,
            "12am": 0,
            "12 PM": 12 * 60,
            "0:00": 0,
            "23:59": 23 * 60 + 59,
        };
        expect(Object.fromEntries(Object.keys(cases).map((text) => [text, parseClock(text)]))).toEqual(cases);
    });

    it(`reads nothing from what is not a time`, () => {
        for (const text of [``, `24:00`, `9:60`, `13pm`, `0am`, `noon`, `9:3`, `12345`]) {
            expect(parseClock(text)).toBeUndefined();
        }
    });

    it(`writes it back on the 24-hour clock, and steps it by quarter hours round the clock`, () => {
        expect(clockText(9 * 60 + 5)).toBe(`09:05`);
        expect(CLOCK_CHIPS.map(clockText)).toEqual([`09:00`, `12:00`, `15:00`, `18:00`]);
        expect(stepClock(9 * 60 + 5, 1)).toBe(9 * 60 + 15);
        expect(stepClock(9 * 60 + 15, 1)).toBe(9 * 60 + 30);
        expect(stepClock(9 * 60 + 5, -1)).toBe(9 * 60);
        expect(stepClock(9 * 60, -1)).toBe(8 * 60 + 45);
        expect(stepClock(23 * 60 + 50, 1)).toBe(0);
        expect(stepClock(0, -1)).toBe(23 * 60 + 45);
    });
});

describe(`the instant a pick names`, () => {
    it(`gives a later day nine in the morning, and today the next whole hour still ahead`, () => {
        const now = at(10, 11, 1, 25);
        expect(defaultClock(at(10, 14), now)).toBe(9 * 60);
        expect(defaultClock(at(10, 11), now)).toBe(2 * 60);
        // 01:59:15 is a minute from 02:00:15, which is past two: the next whole hour still ahead is three.
        expect(defaultClock(at(10, 11), at(10, 11, 1, 59) + 15_000)).toBe(3 * 60);
        expect(defaultClock(at(10, 11), at(10, 11, 23, 20))).toBe(23 * 60 + 30);
        expect(defaultClock(at(10, 11), at(10, 11, 23, 50))).toBe(23 * 60 + 51);
    });

    it(`books a day at the time picked for it, or at its own default`, () => {
        const now = at(10, 11, 1, 25);
        expect(draftInstant({ day: at(10, 14), clock: 15 * 60 }, now)).toBe(at(10, 14, 15));
        expect(draftInstant({ day: at(10, 14) }, now)).toBe(at(10, 14, 9));
        expect(draftInstant({ day: at(10, 11) }, now)).toBe(at(10, 11, 2));
    });

    it(`books a time without a day at its next one, and nothing from neither`, () => {
        const now = at(10, 11, 14);
        expect(draftInstant({ clock: 18 * 60 }, now)).toBe(at(10, 11, 18));
        expect(draftInstant({ clock: 9 * 60 }, now)).toBe(at(10, 12, 9));
        expect(draftInstant({}, now)).toBeUndefined();
    });

    it(`keeps the wall clock across a day's own midnight`, () => {
        const instant = at(10, 25, 9, 30);
        expect(dayOf(instant)).toBe(at(10, 25));
        expect(minuteOfDay(instant)).toBe(9 * 60 + 30);
    });
});
