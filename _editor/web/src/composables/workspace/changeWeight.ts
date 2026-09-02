import { ref, watch, watchEffect, type Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";
import { useLayout } from "../useLayout";
import type { CodeCount } from "./useCodeStats";

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
 * The diffs open on code alone unless comments are asked back (useLayout.showComments), so the counts do too
 * (useCodeStats, ReviewStat) — and a bar sized off git's count sitting beside a code-only number is two answers to
 * one question, forty pixels apart. `shownStat` is the single definition of which reading is showing; the badge
 * draws it, the rail scales to it, and the order sorts by it, so the three can never disagree. A list ordered on
 * one measure while its rails are drawn from another is the same defect the rail exists to fix: a column under a
 * control that says "most added first", with the bars getting LONGER as you read down it.
 *
 * WHEN THE ORDER TAKES THAT READING IS THE WHOLE PROBLEM, because the code-only counts ARRIVE. They are a
 * by-product of having both sides of a file (useCodeStats), so they land per file: in the background as the reader
 * walks the list, and on the click that opens one. An order that took each row's reading the moment it showed up
 * therefore re-sorted the list as its files were read — and the click that selected a row was itself the thing
 * that moved it, out from under the pointer that had just picked it. A key that changes when the list is touched
 * is not a key.
 *
 * So the switch is made ONCE, FOR THE WHOLE LIST, and only while the reader is not using it (`orderReading`):
 *
 *   - until every row on screen has a settled reading, the order ranks on `orderStat`, git's own pair, which every
 *     row has from the moment it arrives. One measure for the whole list, so the ranking means something;
 *   - the first time the list IS counted whole, the order switches to the reading the rows are drawing, and stays
 *     there. That is the one reorder a review gets, in the same breath as the numbers and rails settling, which is
 *     motion the reader is already watching;
 *   - a row that arrives after that (an agent still writing) ranks on git's pair until its own count lands, so the
 *     new row settles into place rather than the whole list re-sorting around it;
 *   - and the switch never happens once the reader has picked a row: a list that is being clicked through holds
 *     the order it had, however late its counting finishes. On a big landing that never finishes, that is git's
 *     order for good, which is stable, honest and the same order for every row.
 *
 * The cost is a review that has not been counted yet ranking a prose-heavy file above one the badges will later
 * say added more. It is bounded, it is early, and it is nothing next to a list that moves when you click it. */

/** The +/− a surface is showing for one change: either reading, whichever this one is drawing. */
export interface ShownStat {
    readonly additions?: number;
    readonly deletions?: number;
}

/** Which of the two readings is on screen. `stripped` is the diff surface showing code alone (the default); a
 *  file with nothing to strip has no `code` and shows git's own, which for it IS the code-only reading. */
export const shownStat = (stripped: boolean, count: CodeCount | undefined, additions?: number, deletions?: number): ShownStat =>
    stripped && count?.code !== undefined ? count.code : { additions, deletions };

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

/** Git's own +/−, which every row has from the moment it arrives and which never changes under the reader: what
 *  a list is ranked on until it has been counted whole. Takes anything carrying the pair — a row's `change`, a
 *  heading's totals — so a file, its package and its repo are all ranked on the same measure. */
export const orderStat = (of: { readonly additions?: number; readonly deletions?: number }): ShownStat => ({
    additions: of.additions,
    deletions: of.deletions,
});

/** Biggest first: most added, and among rows that added the same (usually none at all) most removed. */
export const bigger = (left: ShownStat, right: ShownStat): number =>
    addedIn(right) - addedIn(left) || (right.deletions ?? 0) - (left.deletions ?? 0);

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
    const readingOf = (count: CodeCount | undefined, additions?: number, deletions?: number): ShownStat =>
        shownStat(!showComments.value, count, additions, deletions);
    return {
        largestFirst,
        /** One row's +/− in the reading its own badge is drawing: the pair the rail, the order and the numbers
         *  all read, so none of the three can describe a different change from the other two. */
        readingOf,
        /* THE KEY A LIST SORTS ON, and WHEN it is allowed to change — the note at the top of this file is about
         * this function. Called once per list, in setup, with two questions only the panel can answer:
         *
         *   `counted`: does every row on screen have a settled reading? (its own rows, its own filter);
         *   `touched`: has the reader picked a row in this list yet? (its own selection).
         *
         * Until the list has been counted whole it ranks on git's pair; at the first moment it IS, and only if
         * the reader has not touched it, it switches to the reading the rows are drawing and stays there for
         * good. One reorder, while the badges beside it are settling too, or none at all.
         *
         * The switch is a latch rather than a condition: a row arriving later (an agent still writing) leaves the
         * list where it is and settles into it, instead of throwing every row back to git's order and then
         * forward again — two reorders nobody asked for, per file the agent writes. */
        orderReading(counted: () => boolean, touched: () => boolean) {
            const onShown = ref(false);
            watchEffect(() => {
                if (!onShown.value && !touched() && counted()) {
                    onShown.value = true;
                }
            });
            /* Working the control itself is the reader ASKING to be re-ordered, which is the one reorder they
             * cannot be surprised by — so it is also the way back for a list that froze on git's pair because
             * they clicked a row before the counting caught up. Off and on again, and it ranks on what the
             * badges are showing now. */
            watch(largestFirst, () => {
                if (counted()) {
                    onShown.value = true;
                }
            });
            return (count: CodeCount | undefined, additions?: number, deletions?: number): ShownStat =>
                onShown.value ? readingOf(count, additions, deletions) : orderStat({ additions, deletions });
        },
        /* Biggest first when that is the asked-for reading, and the identical array when it is not — so a panel
         * calls this at every level of its hierarchy without branching, and path order costs nothing. The key is
         * `orderReading`'s, at every one of those levels: a list that ranks its rows on one measure and its
         * headings on another is a list whose top row is not in its top group.
         *
         * The sort is stable (guaranteed since ES2019), which is what makes it safe to apply to a list that is
         * already in path order: rows that added the same amount keep it, so the two files a package changed by
         * four lines each stay in the order the reader would have found them in. */
        bySize: <T>(rows: readonly T[], reading: (row: T) => ShownStat): readonly T[] =>
            largestFirst.value ? [...rows].sort((left, right) => bigger(reading(left), reading(right))) : rows,
    };
}
