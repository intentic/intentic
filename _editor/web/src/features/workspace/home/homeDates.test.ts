import { formatClock, formatDate, formatDayMonth, formatMonth, formatWeekdayTime } from "@intentic/ui/format";
import { dateGroupOf, dateLine } from "./homeDates";

// Local wall-clock times, so the edges hold in whatever timezone the suite runs in.
const at = (year: number, month: number, day: number, hour = 12, minute = 0): number => new Date(year, month - 1, day, hour, minute).getTime();
const NOW = at(2026, 10, 7, 15, 30);
const keyOf = (mtime: number | undefined): string => dateGroupOf(mtime, NOW).key;

describe(`the heading a file sits under`, () => {
    it(`splits the last days at midnight, not at a 24-hour count`, () => {
        expect(keyOf(at(2026, 10, 7, 0, 0))).toBe(`today`);
        expect(keyOf(at(2026, 10, 6, 23, 59))).toBe(`yesterday`);
        expect(keyOf(at(2026, 10, 6, 0, 0))).toBe(`yesterday`);
        expect(keyOf(at(2026, 10, 5, 23, 59))).toBe(`week`);
    });

    it(`counts the previous seven and thirty days back from today's midnight`, () => {
        expect(keyOf(at(2026, 9, 30, 0, 0))).toBe(`week`);
        expect(keyOf(at(2026, 9, 29, 23, 59))).toBe(`month`);
        expect(keyOf(at(2026, 9, 7, 0, 0))).toBe(`month`);
        expect(keyOf(at(2026, 9, 6, 23, 59))).toBe(`m-2026-09`);
    });

    it(`names each earlier month of this year, and each earlier year by its number`, () => {
        expect(dateGroupOf(at(2026, 3, 14), NOW)).toEqual({ key: `m-2026-03`, label: formatMonth(at(2026, 3, 14)) });
        expect(dateGroupOf(at(2025, 12, 31), NOW)).toEqual({ key: `y-2025`, label: `2025` });
        expect(keyOf(at(2019, 6, 1))).toBe(`y-2019`);
    });

    it(`seats a time ahead of now under today, and a missing one under its own heading`, () => {
        expect(keyOf(at(2026, 10, 9))).toBe(`today`);
        expect(keyOf(undefined)).toBe(`undated`);
    });
});

describe(`the line under a file's name`, () => {
    it(`says only what its heading leaves out`, () => {
        expect(dateLine(at(2026, 10, 7, 9, 5), NOW)).toBe(formatClock(at(2026, 10, 7, 9, 5)));
        expect(dateLine(at(2026, 10, 6, 18, 0), NOW)).toBe(formatClock(at(2026, 10, 6, 18, 0)));
        expect(dateLine(at(2026, 10, 2, 18, 0), NOW)).toBe(formatWeekdayTime(at(2026, 10, 2, 18, 0)));
        expect(dateLine(at(2026, 3, 14), NOW)).toBe(formatDayMonth(at(2026, 3, 14)));
        expect(dateLine(at(2024, 3, 14), NOW)).toBe(formatDate(at(2024, 3, 14)));
    });

    it(`is empty with no time, which keeps the tile its height`, () => {
        expect(dateLine(undefined, NOW)).toBe(``);
    });
});
