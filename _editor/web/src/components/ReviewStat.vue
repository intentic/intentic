<script setup lang="ts">
import { DiffStat } from "@intentic/ui";
import { computed } from "vue";
import { useLayout } from "../composables/useLayout";
import type { LineStat } from "../composables/workspace/codeStat";
import { addedIn, shownStat, weightFill } from "../composables/workspace/changeWeight";

/* A changed file's +/− IN THE READING THE SURFACE IS SHOWING: the review's rows and headings, and the bar over
 * the open diff. Every one of them renders this rather than DiffStat directly, because the choice it makes has
 * to be the same choice in all of them: a header that disagrees with the sum of its rows is worse than either
 * number on its own.
 *
 * With comments hidden (the default) the diff is computed on code alone, so the counts are too. Git's own are
 * one hover away and are what the change will land as: the two readings are never both on screen as bare
 * numbers, because two totals side by side is a question, not an answer.
 *
 * A COUNT THAT IS NOT SETTLED YET IS STILL A COUNT, AND IT IS GIT'S: held at half weight, with the hover saying
 * what is still being worked out. This is the rule that replaced a pending mark, and the mark is what earned the
 * replacement: the code-only reading needs both whole sides of a file, which is a daemon read the background
 * reader takes in its own time, so on the workspace Changes panel: beside an agent that is still writing, which
 * is when that list is longest: EVERY row drew three dots and the panel showed no numbers at all. A number the
 * reader can scan, marked as provisional, beats the honest blank that told them nothing; what the mark was
 * protecting against (a number moving under the reader when a click reads the file) is what the half weight and
 * the hover now say out loud. A file with NOTHING TO STRIP (no grammar, bytes, too big to send) is a settled
 * answer at full weight: git's numbers are what its pane shows, line for line.
 *
 * A change that is ENTIRELY comments would otherwise render as +0 −0, which is the badge's way of saying "a
 * rename" and reads as nothing happened. It says what it is instead, and stays in the list: something did change
 * here, and hiding the row would be the reader's decision to make, not this component's.
 *
 * AND HOW BIG IT IS AGAINST ITS NEIGHBOURS (`of`), which is the same question asked of a whole list at once and
 * therefore belongs here rather than in either panel: the rail has to be scaled by the reading the badge beside
 * it is drawing, or the two are two answers to one question forty pixels apart. See changeWeight.ts for why the
 * rail exists at all, and why its scale is compressive. Rows pass `of`; headings and the diff toolbar do not,
 * because their neighbours are not a set anyone ranks. */

const { code, counting, additions, deletions, of } = defineProps<{
    // Code-only counts, once the file has been read and stripped. Absent when the file has no grammar to strip:
    // whose pane shows every line it has, making git's numbers the honest ones.
    code?: LineStat;
    // True while the reading is still being worked out: the file has not been read, so git's count is the only
    // one there is and it is shown as provisional. A total is `counting` when ANY row under it is (see
    // sumCounts): part of a sum is not a sum.
    counting?: boolean;
    // Git's own, comments included.
    additions?: number;
    deletions?: number;
    // The most any one file in this list ADDED. Present ⇒ draw the rail, scaled to it.
    of?: number;
}>();

const { showComments } = useLayout();

// Whether the surface is showing code alone: the only mode in which any of the above matters.
const stripped = computed(() => !showComments.value);
// Git's count standing in for one that has not been worked out yet, and therefore the one reading here that is
// allowed to change. Drawn at half weight, said in the hover.
const provisional = computed(() => stripped.value && counting === true);
const shown = computed(() => shownStat(stripped.value, { code, counting: counting === true }, additions, deletions));
const commentsOnly = computed(
    () => stripped.value && !provisional.value && code?.additions === 0 && code.deletions === 0 && ((additions ?? 0) > 0 || (deletions ?? 0) > 0),
);

// Git's reading, spelled the way the badge spells it, for the hover.
const full = computed(() => [additions ? `+${additions}` : ``, deletions ? `−${deletions}` : ``].filter(Boolean).join(` `));
// Said only when the two readings differ: on everything else the hover would repeat the number under it. While a
// count is provisional the hover is what makes it one, so it is offered as soon as there is a number to qualify;
// a row with nothing to count (a rename, a conflict) draws no badge at all and gets no hover either.
const hint = computed<string | undefined>(() => {
    if (provisional.value) {
        return full.value === `` ? undefined : `${full.value} counting comments, still working out how much of it is code`;
    }
    if (!stripped.value || code === undefined || (code.additions === (additions ?? 0) && code.deletions === (deletions ?? 0))) {
        return undefined;
    }
    return commentsOnly.value ? `Only comments changed, ${full.value} of them` : `Code only · ${full.value} counting comments`;
});

/* --- the rail ------------------------------------------------------------------------------------------------
 * How much new code this file is, against the file that brought the most in this list. See changeWeight.ts for
 * why it measures additions rather than total churn, and why its scale is compressive.
 *
 * A ROW THAT ADDS NOTHING GETS NO RAIL, which is a gap in the column rather than an empty track, and the
 * difference matters: an empty track beside `−1353` would rank a large deletion as the smallest thing on screen,
 * where nothing at all reads as "no new code here" — which is what a deletion is, and is true. The deletion is
 * still on the row, in red, beside a status letter that already says D.
 *
 * NO TOOLTIP, deliberately. The rail sits a few pixels from the number it is scaled to, so a hover would repeat
 * what the reader is already looking at, once per row, in a list the pointer crosses constantly. */
const fill = computed<number | undefined>(() => {
    const added = addedIn(shown.value);
    return of === undefined || of <= 0 || added <= 0 ? undefined : weightFill(added, of);
});
</script>

<template>
    <span
        v-if="commentsOnly"
        class="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-overlay px-1 py-px text-2xs text-subtle"
        v-tooltip.top="hint"
    >
        <Icon name="eye-slash" class="text-2xs" />comments
    </span>
    <!-- Half weight, not a spinner and not a placeholder: a review is a list of these, and a column of pending
         marks is a panel with no numbers on it. The count is git's, it may still be replaced by the code's, and
         both of those facts are what the dimming and the hover are for. -->
    <span v-else-if="hint !== undefined" class="inline-flex shrink-0" :class="provisional ? 'opacity-50' : ''" v-tooltip.top="hint">
        <DiffStat :additions="shown.additions" :deletions="shown.deletions" />
    </span>
    <DiffStat v-else :additions="shown.additions" :deletions="shown.deletions" />
    <!-- AFTER the numbers, which is what makes the rails a column: the counts are variable width, so a bar
         placed before them would start at a different x on every row and there would be nothing to compare. At
         the row's right edge they share an edge and a width, and the eye reads down them. Decorative to a screen
         reader: the number it announces is the same fact, said exactly. -->
    <span
        v-if="fill !== undefined"
        class="flex h-[3px] w-5 shrink-0 overflow-hidden rounded-full bg-overlay"
        :class="provisional ? 'opacity-50' : ''"
        aria-hidden="true"
    >
        <span class="h-full rounded-full bg-success" :style="{ width: `${fill * 100}%` }"></span>
    </span>
</template>
