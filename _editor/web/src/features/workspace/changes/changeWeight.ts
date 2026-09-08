import type { Ref } from "vue";
import type { LineStat } from "@intentic/code-read";
import { definePreference } from "@intentic/ui/preference";
import { useLayout } from "../../../shell/window/useLayout";

// Rail (`weightFill`) and order (`largestFirst`) rank changes by added lines, not total churn, since one large
// deletion shouldn't dominate the scale. `shownStat` is the single reading (code-only or git's) that the rail,
// order and badge all read, fixed once the list arrives so it can't shift after a row is picked.

/** The +/- a surface shows for one change: whichever reading (code-only or git's) is currently on screen. */
export interface ShownStat {
    readonly additions?: number;
    readonly deletions?: number;
}

/**
 * Picks which reading is on screen: code-only when stripped and available, else git's own count.
 * A file the daemon couldn't read as code (binary, oversized, no grammar) has no `code`, so git's count is the reading.
 */
export const shownStat = (stripped: boolean, code: LineStat | undefined, additions?: number, deletions?: number): ShownStat =>
    stripped && code !== undefined ? code : { additions, deletions };

/** Lines added in whichever reading is on screen; churn (additions + deletions) is not the measure. */
export const addedIn = (stat: ShownStat): number => stat.additions ?? 0;

// Floor so even a tiny change draws a visible stub instead of a sub-pixel smudge.
const MIN_FILL = 0.14;

/**
 * Rail fill (0..1) for `added` against the list's biggest addition `of`; square root, not linear, so a lopsided
 * set (a 2-line fix beside a 400-line module) still spreads across a visible range.
 */
export const weightFill = (added: number, of: number): number =>
    added <= 0 || of <= 0 ? 0 : Math.min(1, Math.max(MIN_FILL, Math.sqrt(added / of)));

/** Biggest first: most added lines, then most deletions among ties. */
export const bigger = (left: ShownStat, right: ShownStat): number =>
    addedIn(right) - addedIn(left) || (right.deletions ?? 0) - (left.deletions ?? 0);

/**
 * Totals a run of changes as one code-only reading; a change with no `code` contributes git's own numbers instead,
 * the same substitution `shownStat` makes per row, so a heading agrees with its rows.
 */
export const sumCode = (changes: readonly { readonly code?: LineStat; readonly additions?: number; readonly deletions?: number }[]): LineStat =>
    changes.reduce<LineStat>(
        (total, change) => ({
            additions: total.additions + (change.code?.additions ?? change.additions ?? 0),
            deletions: total.deletions + (change.code?.deletions ?? change.deletions ?? 0),
        }),
        { additions: 0, deletions: 0 },
    );

/** Totals a run of rows as one reading, for a heading ordered against its siblings. */
export const sumShown = (stats: readonly ShownStat[]): ShownStat =>
    stats.reduce<{ additions: number; deletions: number }>(
        (total, stat) => ({ additions: total.additions + (stat.additions ?? 0), deletions: total.deletions + (stat.deletions ?? 0) }),
        { additions: 0, deletions: 0 },
    );

// Most-added-first order preference (Settings > Appearance), shared by both review panels; off by default.
const largestFirst: Ref<boolean> = definePreference<boolean>({
    key: `ui-changes-largest-first`,
    read: (raw) => raw === `on`,
    write: (value) => (value ? `on` : `off`),
});

export function useChangeWeight() {
    const { showComments } = useLayout();
    const readingOf = (code: LineStat | undefined, additions?: number, deletions?: number): ShownStat =>
        shownStat(!showComments.value, code, additions, deletions);
    return {
        largestFirst,
        /** The reading (code-only or git's) that this row's badge, rail and order all read from. */
        readingOf,
        // Sorts biggest-first when asked; otherwise returns the array unchanged. Stable sort keeps path order among
        // ties.
        bySize: <T>(rows: readonly T[], reading: (row: T) => ShownStat): readonly T[] =>
            largestFirst.value ? [...rows].sort((left, right) => bigger(reading(left), reading(right))) : rows,
    };
}
