import type { BrowsingEntry } from "@intentic/sandbox-contract/schemas/browsing";
import { dayName, historyDays, matchesSearch } from "./historyDays";

// Local times, so the grouping is by the reader's own days whatever zone the suite runs in.
const at = (year: number, month: number, day: number, hour = 12, minute = 0): number => new Date(year, month - 1, day, hour, minute).getTime();
const midnight = (year: number, month: number, day: number): number => at(year, month, day, 0);

const page = (url: string, last: number, title?: string): BrowsingEntry => {
    const entry: BrowsingEntry = { url, last, visits: 1, typed: 0, frecency: 1 };
    return title === undefined ? entry : { ...entry, title };
};

const ROUTER = page(`http://192.168.0.168/`, at(2026, 11, 19, 21, 30), `FRITZ!Box`);

const ENTRIES = [
    page(`https://github.com/intentic`, at(2026, 11, 18, 9), `intentic · GitHub`),
    ROUTER,
    page(`https://vuejs.org/guide/`, at(2026, 11, 19, 8), `Guide | Vue.js`),
    page(`https://example.com/`, at(2026, 11, 2, 23, 59)),
];

test("pages are listed newest first, a day to a heading", () => {
    const { days, more } = historyDays(ENTRIES, ``, 100);
    expect(days.map((day) => [day.day, day.entries.map((entry) => entry.url)])).toEqual([
        [midnight(2026, 11, 19), [`http://192.168.0.168/`, `https://vuejs.org/guide/`]],
        [midnight(2026, 11, 18), [`https://github.com/intentic`]],
        [midnight(2026, 11, 2), [`https://example.com/`]],
    ]);
    expect(more).toBe(false);
});

test("the search narrows by every word, in the title or the address", () => {
    expect(historyDays(ENTRIES, `vue GUIDE`, 100).days.flatMap((day) => day.entries.map((entry) => entry.url))).toEqual([`https://vuejs.org/guide/`]);
    expect(matchesSearch(ROUTER, `192.168 fritz`)).toBe(true);
    expect(matchesSearch(ROUTER, `fritz router`)).toBe(false);
    expect(matchesSearch(ROUTER, `   `)).toBe(true);
});

test("a long history is cut at the limit, and says there is more", () => {
    const { days, more } = historyDays(ENTRIES, ``, 2);
    expect(days.flatMap((day) => day.entries).length).toBe(2);
    expect(more).toBe(true);
});

test("a day is named today, yesterday, or by its date", () => {
    const now = at(2026, 11, 19, 22);
    expect(dayName(midnight(2026, 11, 19), now)).toEqual({ kind: `today` });
    expect(dayName(midnight(2026, 11, 18), now)).toEqual({ kind: `yesterday` });
    expect(dayName(midnight(2026, 11, 2), now)).toEqual({ kind: `date`, at: midnight(2026, 11, 2) });
    // Just after midnight, yesterday is the calendar day before, not the last 24 hours.
    expect(dayName(midnight(2026, 11, 18), at(2026, 11, 19, 0, 5))).toEqual({ kind: `yesterday` });
});
