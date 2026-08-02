/* THE APP'S ONE "HOW FAR BACK" VOCABULARY — the 1h / 24h / 7d / All control, the cutoff it means, and the words
 * a caller says about it in prose.
 *
 * Activity and Logs had each written all three: the same four presets, the same three millisecond constants, and
 * two different spellings of the sentence under them ("262 entries in the last 24 hours" vs a bare count). They
 * are the same question asked of two feeds, and a user who learns the control on one surface should not find it
 * shaped differently on the next.
 *
 * `all` is the ABSENCE of a bound, not a very large one: -Infinity compares correctly against any timestamp,
 * including the ones a clock skew puts in the future, where `now - 100 years` quietly does not. */

export type TimeWindow = `1h` | `24h` | `7d` | `all`;

const WINDOW_MS: Readonly<Record<Exclude<TimeWindow, `all`>, number>> = {
    "1h": 3_600_000,
    "24h": 86_400_000,
    "7d": 604_800_000,
};

/** Ready to spread into <Segmented :options>, so the four pills cannot drift apart between two views. */
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

/** True when the entry is inside the window — the filter every feed applies, spelled once. */
export const withinWindow = (at: number, window: TimeWindow, now: number): boolean => at >= sinceOf(window, now);
