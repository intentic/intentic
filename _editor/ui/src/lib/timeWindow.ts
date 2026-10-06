import { formatClock, formatWhen } from "./format.js";
import { t } from "../i18n/index.js";

// Shared "how far back" vocabulary (1h/24h/7d/All): the millisecond cutoffs and the words to describe them. `all`
// is the absence of a bound (-Infinity), not a very large one, so it still compares correctly against a
// clock-skewed future timestamp. At the end, its one "how far ahead" phrase.

export type TimeWindow = `1h` | `24h` | `7d` | `all`;

const WINDOW_MS: Readonly<Record<Exclude<TimeWindow, `all`>, number>> = {
    "1h": 3_600_000,
    "24h": 86_400_000,
    "7d": 604_800_000,
};

/** Ready to spread into <SegmentedControl :options>, so the four pills cannot drift apart between two views. */
export const timeWindows = (): readonly { label: string; value: TimeWindow }[] => [
    { label: t(`ui.timeWindow.hour`), value: `1h` },
    { label: t(`ui.timeWindow.day`), value: `24h` },
    { label: t(`ui.timeWindow.week`), value: `7d` },
    { label: t(`ui.timeWindow.all`), value: `all` },
];

/** The cutoff a window means, as an epoch-ms lower bound. */
export const sinceOf = (window: TimeWindow, now: number): number => (window === `all` ? -Infinity : now - WINDOW_MS[window]);

/** The window as it reads mid-sentence: `${count} entries ${timeWindowWords(window)}`. */
export const timeWindowWords = (window: TimeWindow): string => {
    switch (window) {
        case `1h`:
            return t(`ui.timeWindow.inLastHour`);
        case `24h`:
            return t(`ui.timeWindow.inLastDay`);
        case `7d`:
            return t(`ui.timeWindow.inLastWeek`);
        case `all`:
            return t(`ui.timeWindow.onRecord`);
    }
};

/** True when the entry is inside the window, the filter every feed applies, spelled once. */
export const withinWindow = (at: number, window: TimeWindow, now: number): boolean => at >= sinceOf(window, now);

// Midnight on the reader's own calendar: the day an instant falls on is the reader's, not UTC's.
const dayStart = (at: number): number => new Date(at).setHours(0, 0, 0, 0);

/**
 * An instant a little way ahead, the way someone plans around it: "14:05 today", "14:05 tomorrow", and past tomorrow
 * the kit's own weekday or date (`formatWhen`). Days are counted on the reader's calendar and rounded, so the hour a
 * clock change adds or takes away never turns tomorrow into today.
 */
export const formatUntil = (at: number, now: number = Date.now()): string => {
    const days = Math.round((dayStart(at) - dayStart(now)) / WINDOW_MS[`24h`]);
    if (days === 0) {
        return t(`ui.timeWindow.todayAt`, { time: formatClock(at) });
    }
    return days === 1 ? t(`ui.timeWindow.tomorrowAt`, { time: formatClock(at) }) : formatWhen(at, now);
};
