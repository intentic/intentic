import type { BrowsingEntry } from "@intentic/sandbox-contract/schemas/browsing";

// The history page's list: the pages a profile visited, newest first, narrowed to what the search box says and grouped
// by the day they were last visited on, in the reader's own time zone.

export interface HistoryDay {
    // The local midnight that starts the day: its key, and what its heading is worded from.
    readonly day: number;
    readonly entries: readonly BrowsingEntry[];
}

const startOfDay = (at: number): number => {
    const date = new Date(at);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
};

// Every typed word somewhere in the page's title or address, case aside.
export const matchesSearch = (entry: BrowsingEntry, search: string): boolean => {
    const words = search.toLowerCase().split(/\s+/u).filter((word) => word !== ``);
    if (words.length === 0) {
        return true;
    }
    const haystack = `${entry.title ?? ``} ${entry.url}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
};

export interface HistoryList {
    readonly days: HistoryDay[];
    // Whether pages matched past the limit, for a "show more".
    readonly more: boolean;
}

/** The pages that match, newest first, in days; at most `limit` pages, so a long history renders a screenful at a time. */
export const historyDays = (entries: readonly BrowsingEntry[], search: string, limit: number): HistoryList => {
    const matching = entries.filter((entry) => matchesSearch(entry, search)).toSorted((left, right) => right.last - left.last);
    const days: { day: number; entries: BrowsingEntry[] }[] = [];
    for (const entry of matching.slice(0, limit)) {
        const day = startOfDay(entry.last);
        const current = days.at(-1);
        if (current?.day === day) {
            current.entries.push(entry);
        } else {
            days.push({ day, entries: [entry] });
        }
    }
    return { days, more: matching.length > limit };
};

export type DayName = { readonly kind: `today` } | { readonly kind: `yesterday` } | { readonly kind: `date`; readonly at: number };

/** What a day's heading says: today, yesterday, or its date. */
export const dayName = (day: number, now: number): DayName => {
    const today = startOfDay(now);
    if (day === today) {
        return { kind: `today` };
    }
    // A day before today's midnight, by the calendar rather than by 24 hours, so a clock change is no gap.
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return day === yesterday.getTime() ? { kind: `yesterday` } : { kind: `date`, at: day };
};

// The stretches the history page can clear, back from now.
export const CLEAR_SPANS = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 } as const;
export type ClearSpan = keyof typeof CLEAR_SPANS | `all`;
