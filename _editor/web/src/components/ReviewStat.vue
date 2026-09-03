<script setup lang="ts">
import { DiffStat } from "@intentic/ui";
import { computed } from "vue";
import { useLayout } from "../composables/useLayout";
import type { LineStat } from "@intentic/code-read";
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
 * EVERY NUMBER HERE IS FINAL WHEN IT IS FIRST DRAWN. The code-only reading arrives on the change itself, worked
 * out by the daemon that has the files (git/code-counts.ts), so this component has no pending state, no half
 * weight and no "still counting" hover: there is nothing left to arrive. It used to have all three, because the
 * app worked each row's count out as the diffs were fetched — which meant a badge redrew under whoever was
 * reading it, a row turned into a "comments" pill on the click that opened it, and a list sorted by size moved
 * while it was being clicked through. A file the daemon could NOT read that way (bytes, one side too large, a
 * language this build ships no grammar for) carries no `code` at all, and git's numbers are then the reading,
 * exactly as they are for the pane beside it.
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

const { code, additions, deletions, of } = defineProps<{
    // The change with its comments stripped out, as the daemon counted it. Absent for a file there is no such
    // reading of, whose pane shows every line it has, making git's numbers the honest ones.
    code?: LineStat;
    // Git's own, comments included.
    additions?: number;
    deletions?: number;
    // The most any one file in this list ADDED. Present ⇒ draw the rail, scaled to it.
    of?: number;
}>();

const { showComments } = useLayout();

// Whether the surface is showing code alone: the only mode in which any of the above matters.
const stripped = computed(() => !showComments.value);
const shown = computed(() => shownStat(stripped.value, code, additions, deletions));
const commentsOnly = computed(() => stripped.value && code?.additions === 0 && code.deletions === 0 && ((additions ?? 0) > 0 || (deletions ?? 0) > 0));

// Git's reading, spelled the way the badge spells it, for the hover.
const full = computed(() => [additions ? `+${additions}` : ``, deletions ? `−${deletions}` : ``].filter(Boolean).join(` `));
// Said only when the two readings differ: on everything else the hover would repeat the number under it. A row
// with nothing to count (a rename, a conflict) draws no badge at all and gets no hover either.
const hint = computed<string | undefined>(() => {
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
    <!-- The hover is the only place the two readings are ever both said: the badge shows one number, and what
         that number leaves out is a question, not a second answer to put beside it. -->
    <span v-else-if="hint !== undefined" class="inline-flex shrink-0" v-tooltip.top="hint">
        <DiffStat :additions="shown.additions" :deletions="shown.deletions" />
    </span>
    <DiffStat v-else :additions="shown.additions" :deletions="shown.deletions" />
    <!-- AFTER the numbers, which is what makes the rails a column: the counts are variable width, so a bar
         placed before them would start at a different x on every row and there would be nothing to compare. At
         the row's right edge they share an edge and a width, and the eye reads down them. Decorative to a screen
         reader: the number it announces is the same fact, said exactly. -->
    <span v-if="fill !== undefined" class="flex h-0.75 w-5 shrink-0 overflow-hidden rounded-full bg-overlay" aria-hidden="true">
        <span class="h-full rounded-full bg-success" :style="{ width: `${fill * 100}%` }"></span>
    </span>
</template>
