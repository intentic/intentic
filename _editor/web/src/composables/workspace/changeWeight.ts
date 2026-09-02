import type { Ref } from "vue";
import type { LineStat } from "@intentic/code-read";
import { definePreference } from "@intentic/ui/preference";
import { useLayout } from "../useLayout";

/* WHICH OF THESE FILES ACTUALLY MATTERS — the question a change list is worst at answering, and the one every
 * review opens with.
 *
 * A review is a column of near-identical rows: a status letter, a coloured glyph, a path, and a pair of numbers
 * at 3xs in the far corner. The numbers are the answer, and they are unreadable AS A SET: finding the file that
 * carries the change means reading thirty pairs of digits and holding a running maximum in your head, so nobody
 * does it. They click the first row and walk down, spending the same attention on `README.md +2 −2` as on the
 * 131-line rewrite six rows below it.
 *
 * Two things come out of this file, and they are deliberately not the same mechanism:
 *
 *   - THE RAIL (`weightFill`, drawn by ReviewStat). A short bar beside every row's numbers, filled against the
 *     biggest file in the list. Always on, costs no interaction, and answers the question BY SCANNING: length is
 *     the one visual channel a reader ranks without reading. It is a ranking device, not a readout, which is why
 *     the scale below is compressive; the numbers next to it stay the exact answer.
 *   - THE ORDER (`largestFirst`). The obvious move is to sort the biggest to the top, and on its own it is the
 *     wrong default: path order is stable, learned, and the thing a reader navigates by, and the grouping over it
 *     (repo, then package) is how attention gets allocated in the first place. So it is a reading the user asks
 *     for, and when they ask, it is applied WITHIN the hierarchy rather than flattening it, see the panels.
 *
 * ADDED LINES ARE THE MEASURE, NOT TOTAL CHURN, and this is the decision the whole file turns on.
 *
 * Churn is the obvious measure and it is wrong for what a reviewer is doing. Added lines have to be READ and
 * understood, one at a time; a deletion is usually a single decision ("should this be gone?") however many
 * lines it spans. Worse, churn hands the scale to whatever the changeset happened to delete, and one deleted
 * vendored bundle is enough to bury everything else: in the changeset that prompted this, a removed 1,353-line
 * `extension.js` set the top of the scale, so the two 131-line rewrites that WERE the change drew a third of a
 * bar each — behind a deleted Dockerfile. The measure has to be robust to that, and additions are.
 *
 * A row that adds nothing therefore draws no rail at all, and that is the honest answer rather than an omission:
 * an empty track next to `−1353` would say "this is the smallest change here", where a gap says "nothing new to
 * read", which is exactly what a deletion is. Deletions are not lost — they are on the row, in red, next to the
 * status letter that already says `D` — they are just not what the ranking is about. They do break ties, so a
 * list of pure deletions still reads biggest-first instead of falling back to nothing.
 *
 * ALL THREE READ WHAT IS ON SCREEN, never git's raw numbers, and that is the invariant this file exists to hold.
 * The diffs open on code alone unless comments are asked back (useLayout.showComments), so the counts do too —
 * and a bar sized off git's count sitting beside a code-only number is two answers to one question, forty pixels
 * apart. `shownStat` is the single definition of which reading is showing; the badge draws it, the rail scales to
 * it, and the order sorts by it, so the three can never disagree.
 *
 * AND ALL THREE ARE FINAL THE MOMENT THE LIST ARRIVES, which is what makes the reading above safe to sort on. The
 * code-only pair rides on the change itself (GitChange.code, computed by the daemon in git/code-counts.ts), so
 * nothing here is waiting on a file to be read. It used to be: the app worked each row's count out as the diffs
 * happened to be fetched, so a badge redrew, a comments-only row turned into a "comments" pill, and a list sorted
 * by size re-sorted around it — on the click that had just selected a row, which moved that row out from under
 * the pointer that picked it. A number the reader sees is now the number it stays.*/

/** The +/− a surface is showing for one change: either reading, whichever this one is drawing. */
export interface ShownStat {
    readonly additions?: number;
    readonly deletions?: number;
}

/** Which of the two readings is on screen. `stripped` is the diff surface showing code alone (the default); a
 *  file the daemon could not read that way carries no `code` at all and shows git's own, which for it IS the
 *  reading — a binary file, one side too large, a language this build ships no grammar for. */
export const shownStat = (stripped: boolean, code: LineStat | undefined, additions?: number, deletions?: number): ShownStat =>
    stripped && code !== undefined ? code : { additions, deletions };

/** How much of a read a change is: the lines it ADDS, in whichever reading is on screen. See the note above for
 *  why this is not additions + deletions. */
export const addedIn = (stat: ShownStat): number => stat.additions ?? 0;

/* A one-line change must still draw something: at 20px a truly proportional stub for a 2-line file next to a
 * 1300-line one is a sub-pixel smudge, which reads as a rendering fault rather than as "small". */
const MIN_FILL = 0.14;

/** The rail's fill, 0..1, for a change that added `added` lines in a list whose biggest addition is `of`.
 *
 *  SQUARE ROOT, not linear, and the reason is what the rail is for. A real changeset spans two or three orders of
 *  magnitude (a 2-line import fix beside a 400-line new module), and on a linear scale that renders every row but
 *  the outlier as the same invisible stub — the exact failure the rail exists to fix, reproduced in a bar. Length
 *  is read linearly, so this is a deliberate distortion, and it is the right one here: the rail RANKS (which of
 *  these is the big one), the numbers beside it QUANTIFY (how big), and the compressive scale is what spreads a
 *  lopsided set across the range the eye can actually tell apart. */
export const weightFill = (added: number, of: number): number =>
    added <= 0 || of <= 0 ? 0 : Math.min(1, Math.max(MIN_FILL, Math.sqrt(added / of)));

/** Biggest first: most added, and among rows that added the same (usually none at all) most removed. */
export const bigger = (left: ShownStat, right: ShownStat): number =>
    addedIn(right) - addedIn(left) || (right.deletions ?? 0) - (left.deletions ?? 0);

/** A run of changes as ONE code-only reading, for the heading that totals them. A change the daemon could not
 *  read that way (bytes, oversize, no grammar) contributes git's own numbers, which for it ARE the reading —
 *  the same substitution `shownStat` makes for a single row, so a heading and its rows still agree. */
export const sumCode = (changes: readonly { readonly code?: LineStat; readonly additions?: number; readonly deletions?: number }[]): LineStat =>
    changes.reduce<LineStat>(
        (total, change) => ({
            additions: total.additions + (change.code?.additions ?? change.additions ?? 0),
            deletions: total.deletions + (change.code?.deletions ?? change.deletions ?? 0),
        }),
        { additions: 0, deletions: 0 },
    );

/** A run of rows as one reading, for the heading that has to be ordered against its siblings. */
export const sumShown = (stats: readonly ShownStat[]): ShownStat =>
    stats.reduce<{ additions: number; deletions: number }>(
        (total, stat) => ({ additions: total.additions + (stat.additions ?? 0), deletions: total.deletions + (stat.deletions ?? 0) }),
        { additions: 0, deletions: 0 },
    );

/* Whether the review lists read MOST-ADDED FIRST or in git's own path order (the default). An account
 * preference, like the module grouping beside it (useChangeGrouping), and shared by both review surfaces for the
 * same reason: "how do I read a change list" is not a question anyone wants to answer twice, and the workspace's
 * Changes panel and the fleet's agent review disagreeing about the order of one change set is exactly the seam
 * that makes two panels feel like two products.
 *
 * OFF by default. Path order is what a reader navigates by and what every other git surface shows them; the rail
 * already answers "which is the big one" without moving anything, so the reorder is left as the stronger ask it
 * is — for the review where the answer is "just show me the three files that matter". */
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
        /** One row's +/− in the reading its own badge is drawing: the pair the rail, the order and the numbers
         *  all read, so none of the three can describe a different change from the other two. */
        readingOf,
        /* Biggest first when that is the asked-for reading, and the identical array when it is not — so a panel
         * calls this at every level of its hierarchy without branching, and path order costs nothing. The key is
         * `readingOf`'s at every one of those levels: a list that ranks its rows on one measure and its headings
         * on another is a list whose top row is not in its top group.
         *
         * The sort is stable (guaranteed since ES2019), which is what makes it safe to apply to a list that is
         * already in path order: rows that added the same amount keep it, so the two files a package changed by
         * four lines each stay in the order the reader would have found them in. */
        bySize: <T>(rows: readonly T[], reading: (row: T) => ShownStat): readonly T[] =>
            largestFirst.value ? [...rows].sort((left, right) => bigger(reading(left), reading(right))) : rows,
    };
}
