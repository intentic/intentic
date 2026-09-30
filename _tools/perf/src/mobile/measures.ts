import type { PageRecord } from "./page-scripts.js";

// What a page record says, as the few numbers a phone's reader feels. Pure, so each is pinned by a test.

export interface Interaction {
    readonly id: number;
    /** The longest of its events, which is what INP counts for it. */
    readonly duration: number;
    readonly inputDelay: number;
    readonly processing: number;
    readonly presentation: number;
    readonly target: string;
}

/** Each interaction once, measured by its longest event, longest first. */
export const interactions = (events: PageRecord["events"]): readonly Interaction[] => {
    const longest = new Map<number, PageRecord["events"][number]>();
    for (const event of events) {
        if (event.interaction === 0) {
            continue;
        }
        const held = longest.get(event.interaction);
        if (held === undefined || event.duration > held.duration) {
            longest.set(event.interaction, event);
        }
    }
    return [...longest.entries()]
        .map(([id, event]) => ({
            id,
            duration: event.duration,
            inputDelay: event.inputDelay,
            processing: event.processing,
            presentation: event.presentation,
            target: event.target,
        }))
        .toSorted((a, b) => b.duration - a.duration);
};

/** Layout shift not caused by the reader's own input, summed: the page's CLS for a short visit. */
export const layoutShift = (shifts: PageRecord["shifts"]): number =>
    Math.round(shifts.filter((shift) => !shift.recentInput).reduce((sum, shift) => sum + shift.value, 0) * 1000) / 1000;

export const longTaskTotal = (tasks: PageRecord["longTasks"]): number => tasks.reduce((sum, task) => sum + task.duration, 0);

export const longestTask = (tasks: PageRecord["longTasks"]): number => tasks.reduce((most, task) => Math.max(most, task.duration), 0);

export const paintAt = (record: PageRecord, name: string): number | undefined => record.paints.find((paint) => paint.name === name)?.start;

/** The median of several runs, so one noisy run does not speak for the rest. */
export const median = (values: readonly number[]): number => {
    const sorted = values.toSorted((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : Math.round((((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2) * 1000) / 1000;
};
