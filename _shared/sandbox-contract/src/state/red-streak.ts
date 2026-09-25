// ONE DEFINITION OF A RED STREAK, for every source that goes red: a land check's project (verify-store.ts), main's CI
// (repair-gate.ts), a pipeline branch on the board (the pipelines extension's ciStreaks.ts) and the Main line's older
// daemons (the editor's mainlineView.ts). A streak is the unbroken run of red at the head: a red extends it, anything
// else ends it, and `since` is where it began, which is what names one failure across every red that continues it.

export interface Streak {
    // When (or at which run) the streak began: the first red of the unbroken run.
    readonly since: number;
    // How many reds in a row it holds.
    readonly count: number;
}

/**
 * One observation's effect on the streak before it. A red continues it, unless `continues` says this red is a different
 * failure (CI: no failed job repeats), which begins one of its own; anything else ends it.
 */
export const nextStreak = (previous: Streak | undefined, red: boolean, at: number, continues = true): Streak | undefined => {
    if (!red) {
        return undefined;
    }
    return previous !== undefined && continues ? { since: previous.since, count: previous.count + 1 } : { since: at, count: 1 };
};

/** The streak a newest-first history stands on: its unbroken run of red at the head, newest first; empty when the head is not red. */
export const headStreak = <T>(newestFirst: readonly T[], isRed: (item: T) => boolean): T[] => {
    const end = newestFirst.findIndex((item) => !isRed(item));
    return end === -1 ? [...newestFirst] : newestFirst.slice(0, end);
};
