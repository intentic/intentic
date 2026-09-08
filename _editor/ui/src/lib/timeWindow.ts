// Shared "how far back" vocabulary (1h/24h/7d/All): the millisecond cutoffs and the words to describe them. `all`
// is the absence of a bound (-Infinity), not a very large one, so it still compares correctly against a
// clock-skewed future timestamp.

export type TimeWindow = `1h` | `24h` | `7d` | `all`;

const WINDOW_MS: Readonly<Record<Exclude<TimeWindow, `all`>, number>> = {
    "1h": 3_600_000,
    "24h": 86_400_000,
    "7d": 604_800_000,
};

/** Ready to spread into <SegmentedControl :options>, so the four pills cannot drift apart between two views. */
export const TIME_WINDOWS: readonly { label: string; value: TimeWindow }[] = [
    { label: `1h`, value: `1h` },
    { label: `24h`, value: `24h` },
    { label: `7d`, value: `7d` },
    { label: `All`, value: `all` },
];

/** The cutoff a window means, as an epoch-ms lower bound. */
export const sinceOf = (window: TimeWindow, now: number): number => (window === `all` ? -Infinity : now - WINDOW_MS[window]);

/** The window as it reads mid-sentence: `${count} entries ${timeWindowWords(window)}`. */
export const timeWindowWords = (window: TimeWindow): string =>
    ({ "1h": `in the last hour`, "24h": `in the last 24 hours`, "7d": `in the last 7 days`, all: `on record` })[window];

/** True when the entry is inside the window, the filter every feed applies, spelled once. */
export const withinWindow = (at: number, window: TimeWindow, now: number): boolean => at >= sinceOf(window, now);
