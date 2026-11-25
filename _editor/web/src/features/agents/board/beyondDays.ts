import { formatDate, formatDayHeading, formatDayMonth, formatWeekdayLong } from "@intentic/ui/format";

// What the board's filter found off the board, as BeyondResults draws it: one list, newest first, cut into calendar days
// in the reader's own timezone. A day is named once, beside its rows, so no row carries a date and the order reads top
// to bottom. The two-column grid this replaced filled left to right, so its dates zigzagged and the reader had to
// compare both columns to know which hit came first. Pure, with `now` handed in, so the edges are tested by value.

export interface Dated {
    readonly at: number;
}

export interface FoundDay<T extends Dated> {
    // The day's local midnight: unique per day, so it keys the block.
    readonly key: number;
    // "Today", "Yesterday", then the weekday: "Tuesday".
    readonly head: string;
    // The calendar day under it: "Nov 18", with the year once it is not this one's.
    readonly date: string;
    readonly rows: readonly T[];
}

const midnight = (at: number): number => new Date(at).setHours(0, 0, 0, 0);

/** Newest first, ties left in the order they came (the archive's own). */
export const newestFirst = <T extends Dated>(rows: readonly T[]): T[] => [...rows].sort((a, b) => b.at - a.at);

/**
 * The two lines naming the day `at` falls on, seen at `now`. A time ahead of `now` (a clock that disagrees) is today's:
 * it is the newest thing in the list, which is where it sorts.
 */
export const dayName = (at: number, now: number): Pick<FoundDay<Dated>, "head" | "date"> => {
    const days = Math.round((midnight(now) - midnight(at)) / 86_400_000);
    const head = days <= 1 ? formatDayHeading(days < 0 ? now : at, now) : formatWeekdayLong(at);
    const date = new Date(at).getFullYear() === new Date(now).getFullYear() ? formatDayMonth(at) : formatDate(at);
    return { head, date };
};

/** Rows already newest first, cut where the calendar day changes. */
export const byDay = <T extends Dated>(rows: readonly T[], now: number): FoundDay<T>[] => {
    const days: { key: number; head: string; date: string; rows: T[] }[] = [];
    for (const row of rows) {
        const key = midnight(row.at);
        const last = days.at(-1);
        if (last?.key === key) {
            last.rows.push(row);
        } else {
            days.push({ key, ...dayName(row.at, now), rows: [row] });
        }
    }
    return days;
};
