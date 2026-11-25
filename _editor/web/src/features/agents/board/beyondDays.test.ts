import { formatDate, formatDayHeading, formatDayMonth, formatWeekdayLong } from "@intentic/ui/format";
import { byDay, dayName, newestFirst } from "./beyondDays";

// Local wall-clock times, so the edges hold in whatever timezone the suite runs in.
const at = (year: number, month: number, day: number, hour = 12, minute = 0): number => new Date(year, month - 1, day, hour, minute).getTime();
const NOW = at(2026, 11, 25, 15, 30);
const hit = (id: string, when: number) => ({ id, at: when });

describe(`the order the found list reads in`, () => {
    it(`puts the newest first and keeps the archive's own order among ties`, () => {
        const rows = [hit(`old`, at(2026, 11, 11)), hit(`a`, at(2026, 11, 24)), hit(`new`, at(2026, 11, 25, 9)), hit(`b`, at(2026, 11, 24))];
        expect(newestFirst(rows).map((row) => row.id)).toEqual([`new`, `a`, `b`, `old`]);
    });
});

describe(`the days the list is cut into`, () => {
    it(`cuts at midnight, not at a 24-hour count, and names each day once`, () => {
        const rows = newestFirst([
            hit(`morning`, at(2026, 11, 25, 0, 0)),
            hit(`late`, at(2026, 11, 24, 23, 59)),
            hit(`early`, at(2026, 11, 24, 0, 0)),
            hit(`sunday`, at(2026, 11, 23, 18)),
        ]);
        const days = byDay(rows, NOW);
        expect(days.map((day) => day.rows.map((row) => row.id))).toEqual([[`morning`], [`late`, `early`], [`sunday`]]);
        expect(new Set(days.map((day) => day.key)).size).toBe(days.length);
    });

    it(`says Today and Yesterday in words, then the weekday, with the calendar day under each`, () => {
        expect(dayName(at(2026, 11, 25, 8), NOW)).toEqual({ head: formatDayHeading(NOW, NOW), date: formatDayMonth(at(2026, 11, 25, 8)) });
        expect(dayName(at(2026, 11, 24, 8), NOW).head).toBe(formatDayHeading(at(2026, 11, 24, 8), NOW));
        expect(dayName(at(2026, 11, 18), NOW)).toEqual({ head: formatWeekdayLong(at(2026, 11, 18)), date: formatDayMonth(at(2026, 11, 18)) });
    });

    it(`adds the year once the day is not this year's`, () => {
        expect(dayName(at(2025, 12, 30), NOW).date).toBe(formatDate(at(2025, 12, 30)));
    });

    it(`names a time ahead of now as today, where it sorts`, () => {
        expect(dayName(at(2026, 11, 27), NOW).head).toBe(formatDayHeading(NOW, NOW));
    });
});
